import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { Org } from '@salesforce/core';
import { buildCmsImportArgs, runCmsImport, runCmsInfo, type CmsCliOptions } from '../cms/cmsCli.js';
import type { CmsEnvelope, CmsImportResult } from '../cms/contracts.js';

export type CmsExecutionRoute = {
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  sourceDirectory: string;
  manifestSha256: string;
  dryRunArgs: string[];
  applyArgs: string[];
};

export type CmsExecutionPlan = {
  contract: 'sf-mcnext-cms-execution-plan';
  contractVersion: '1.0.0';
  planId: string;
  sourcePlanFile: string;
  sourcePlanSha256: string;
  targetOrgId: string;
  targetOrg: string;
  provider: { name: 'sf-plugin-cms'; version: string; infoContractMajor: 1; importContractMajor: 1 };
  workspaceMapSha256: string;
  experimental: true;
  routes: CmsExecutionRoute[];
};

export type CmsExecutionResult = {
  contract: 'sf-mcnext-cms-execution-result';
  contractVersion: '1.0.0';
  planId: string;
  mode: 'dry-run' | 'apply';
  status: 'success' | 'partial' | 'failed' | 'blocked';
  completedRoutes: Array<{ sourceWorkspaceId: string; result: CmsEnvelope<CmsImportResult> }>;
  stoppedAt?: string;
};

type RouteInput = { sourceWorkspaceId: string; targetWorkspaceId: string; sourceDirectory: string };

export async function buildCmsExecutionPlan(input: {
  sourcePlanFile: string;
  sourcePlanSha256: string;
  targetOrg: string;
  targetOrgId: string;
  workspaceMapSha256: string;
  routes: RouteInput[];
  reportRoot: string;
  cli?: CmsCliOptions;
}): Promise<CmsExecutionPlan> {
  assertSalesforceId(input.targetOrgId, 'target org ID');
  const info = await runCmsInfo(input.cli);
  if (info.capabilities.workspaceImport !== 'experimental') {
    throw new Error('CMS workspace import capability must be explicitly experimental');
  }
  const routes = [];
  for (const route of [...input.routes].sort((left, right) => left.sourceWorkspaceId.localeCompare(right.sourceWorkspaceId))) {
    assertSalesforceId(route.sourceWorkspaceId, 'source workspace ID');
    assertSalesforceId(route.targetWorkspaceId, 'target workspace ID');
    // eslint-disable-next-line no-await-in-loop -- canonical route binding is intentionally serialized
    const sourceDirectory = await canonicalDirectory(route.sourceDirectory);
    // eslint-disable-next-line no-await-in-loop -- manifest binding is captured beside its canonical route
    const manifestSha256 = sha256(await readFile(join(sourceDirectory, 'manifest.json')));
    const reportDirectory = join(resolve(input.reportRoot), route.sourceWorkspaceId);
    routes.push({
      ...route,
      sourceDirectory,
      manifestSha256,
      dryRunArgs: buildCmsImportArgs({ targetOrg: input.targetOrg, targetWorkspaceId: route.targetWorkspaceId, sourceDirectory }),
      applyArgs: buildCmsImportArgs({
        targetOrg: input.targetOrg,
        targetWorkspaceId: route.targetWorkspaceId,
        sourceDirectory,
        reportDirectory,
      }),
    });
  }
  const sourcePlanFile = await canonicalFile(input.sourcePlanFile);
  if (sha256(await readFile(sourcePlanFile)) !== input.sourcePlanSha256) throw new Error('source migration plan changed');
  const unsigned = {
    contract: 'sf-mcnext-cms-execution-plan' as const,
    contractVersion: '1.0.0' as const,
    sourcePlanFile,
    sourcePlanSha256: input.sourcePlanSha256,
    targetOrgId: input.targetOrgId,
    targetOrg: input.targetOrg,
    provider: {
      name: 'sf-plugin-cms' as const,
      version: info.envelope.result!.plugin.version,
      infoContractMajor: 1 as const,
      importContractMajor: 1 as const,
    },
    workspaceMapSha256: input.workspaceMapSha256,
    experimental: true as const,
    routes,
  };
  return { ...unsigned, planId: sha256(Buffer.from(JSON.stringify(unsigned))) };
}

export async function executeCmsPlan(input: {
  plan: CmsExecutionPlan;
  targetOrg: Org;
  apply: boolean;
  allowExperimental: boolean;
  cli?: CmsCliOptions;
}): Promise<CmsExecutionResult> {
  if (!input.allowExperimental) throw new Error('--allow-experimental-cms is required');
  await revalidatePlan(input.plan, input.targetOrg, input.cli);
  const completedRoutes: CmsExecutionResult['completedRoutes'] = [];
  for (const route of input.plan.routes) {
    // eslint-disable-next-line no-await-in-loop -- route preflight is deliberately sequential
    const dryRun = await runCmsImport(
      { targetOrg: input.plan.targetOrg, targetWorkspaceId: route.targetWorkspaceId, sourceDirectory: route.sourceDirectory },
      input.cli
    );
    assertImportBindings(dryRun, input.plan, route);
    if (dryRun.status !== 'success') {
      return result(input.plan, input.apply, dryRun.status, completedRoutes, route.sourceWorkspaceId);
    }
    if (!input.apply) {
      completedRoutes.push({ sourceWorkspaceId: route.sourceWorkspaceId, result: dryRun });
      continue;
    }
  }
  if (input.apply) {
    for (const route of input.plan.routes) {
      // eslint-disable-next-line no-await-in-loop -- immutable bindings are revalidated immediately before each mutation
      await revalidatePlan(input.plan, input.targetOrg, input.cli);
      // eslint-disable-next-line no-await-in-loop -- apply-time preflight prevents stale provider or target state
      const secondPreflight = await runCmsImport(
        { targetOrg: input.plan.targetOrg, targetWorkspaceId: route.targetWorkspaceId, sourceDirectory: route.sourceDirectory },
        input.cli
      );
      assertImportBindings(secondPreflight, input.plan, route);
      if (secondPreflight.status !== 'success') {
        return result(input.plan, true, secondPreflight.status, completedRoutes, route.sourceWorkspaceId);
      }
      assertCreateOnlyPreflight(secondPreflight);
      // eslint-disable-next-line no-await-in-loop -- durable bindings are checked again after preflight, immediately before mutation
      await revalidatePlan(input.plan, input.targetOrg, input.cli);
      const reportDirectory = route.applyArgs[11];
      if (reportDirectory === undefined) throw new Error('CMS apply report binding is missing');
      // eslint-disable-next-line no-await-in-loop -- canonical apply order stops at the first provider failure
      const applied = await runCmsImport(
        {
          targetOrg: input.plan.targetOrg,
          targetWorkspaceId: route.targetWorkspaceId,
          sourceDirectory: route.sourceDirectory,
          reportDirectory,
        },
        input.cli
      );
      assertImportBindings(applied, input.plan, route);
      completedRoutes.push({ sourceWorkspaceId: route.sourceWorkspaceId, result: applied });
      if (applied.status !== 'success') {
        return result(input.plan, true, applied.status, completedRoutes, route.sourceWorkspaceId);
      }
    }
  }
  return result(input.plan, input.apply, 'success', completedRoutes);
}

export async function writeCmsExecutionResult(file: string, value: CmsExecutionResult): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

async function revalidatePlan(plan: CmsExecutionPlan, org: Org, cli?: CmsCliOptions): Promise<void> {
  assertSalesforceId(org.getOrgId(), 'resolved target org ID');
  if (org.getOrgId() !== plan.targetOrgId) throw new Error('target org binding changed');
  const sourcePlanFile = await canonicalFile(plan.sourcePlanFile);
  if (sourcePlanFile !== plan.sourcePlanFile || sha256(await readFile(sourcePlanFile)) !== plan.sourcePlanSha256) {
    throw new Error('source migration plan binding changed');
  }
  const info = await runCmsInfo(cli);
  if (info.envelope.result!.plugin.version !== plan.provider.version || info.capabilities.workspaceImport !== 'experimental')
    throw new Error('CMS provider binding changed');
  const expectedPlanId = sha256(
    Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planId'))))
  );
  if (expectedPlanId !== plan.planId) throw new Error('CMS execution plan fingerprint changed');
  await Promise.all(
    plan.routes.map(async (route) => {
      const canonical = await canonicalDirectory(route.sourceDirectory);
      if (canonical !== route.sourceDirectory) throw new Error('CMS package path binding changed');
      if (sha256(await readFile(join(canonical, 'manifest.json'))) !== route.manifestSha256)
        throw new Error('CMS manifest binding changed');
    })
  );
}

function result(
  plan: CmsExecutionPlan,
  apply: boolean,
  status: CmsExecutionResult['status'],
  completedRoutes: CmsExecutionResult['completedRoutes'],
  stoppedAt?: string
): CmsExecutionResult {
  return {
    contract: 'sf-mcnext-cms-execution-result',
    contractVersion: '1.0.0',
    planId: plan.planId,
    mode: apply ? 'apply' : 'dry-run',
    status,
    completedRoutes,
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
  };
}

function assertCreateOnlyPreflight(envelope: CmsEnvelope<CmsImportResult>): void {
  if (
    envelope.result === null ||
    envelope.result.mappings.some(
      (mapping) => mapping.operation !== 'created' || mapping.status !== 'resolved' || !mapping.cmsReferencesRewritten
    ) ||
    envelope.result.references.some((reference) => reference.status !== 'resolved')
  ) {
    throw new Error('CMS preflight is not safe for create-only apply');
  }
}

function assertImportBindings(
  envelope: CmsEnvelope<CmsImportResult>,
  plan: CmsExecutionPlan,
  route: CmsExecutionRoute
): void {
  if (
    envelope.metadata.plugin.name !== plan.provider.name ||
    envelope.metadata.plugin.version !== plan.provider.version ||
    envelope.result === null ||
    envelope.result.target.orgId !== plan.targetOrgId ||
    envelope.result.target.workspaceId !== route.targetWorkspaceId ||
    envelope.result.sourcePackage.workspaceId !== route.sourceWorkspaceId ||
    envelope.result.sourcePackage.manifestSha256 !== route.manifestSha256
  ) {
    throw new Error('CMS import result binding changed');
  }
}

async function canonicalDirectory(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error('CMS source directory must be absolute');
  const metadata = await lstat(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('CMS source directory must be a regular directory');
  return realpath(value);
}

async function canonicalFile(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error('source migration plan file must be absolute');
  const metadata = await lstat(value);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('source migration plan must be a regular file');
  return realpath(value);
}

function assertSalesforceId(value: string, label: string): void {
  if (!/^[A-Za-z0-9]{18}$/u.test(value)) throw new Error(`${label} must be an exact 18-character Salesforce ID`);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
