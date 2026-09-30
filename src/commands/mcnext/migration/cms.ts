import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Messages, Org, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import type { MigrationPlan } from '../../../migration/migrationPlan.js';
import {
  buildCmsExecutionPlan,
  executeCmsPlan,
  writeCmsExecutionResult,
  type CmsExecutionResult,
} from '../../../migration/cmsExecution.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.migration.cms');

export const cmsExecutionServices = {
  buildPlan: buildCmsExecutionPlan,
  executePlan: executeCmsPlan,
  writeResult: writeCmsExecutionResult,
};

export default class MigrationCmsCommand extends SfCommand<CmsExecutionResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:migration:cms'];

  public static readonly flags = {
    'target-org': Flags.string({
      // eslint-disable-next-line sf-plugin/dash-o -- target-org convention intentionally uses -o
      char: 'o',
      required: true,
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'expected-target-org-id': Flags.string({
      required: true,
      summary: messages.getMessage('flags.expected-target-org-id.summary'),
    }),
    'plan-file': Flags.file({ exists: true, required: true, summary: messages.getMessage('flags.plan-file.summary') }),
    'result-file': Flags.string({ required: true, summary: messages.getMessage('flags.result-file.summary') }),
    'report-root': Flags.string({ required: true, summary: messages.getMessage('flags.report-root.summary') }),
    'allow-experimental-cms': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.allow-experimental-cms.summary'),
    }),
    apply: Flags.boolean({ default: false, summary: messages.getMessage('flags.apply.summary') }),
  };

  public async run(): Promise<CmsExecutionResult> {
    const { flags } = await this.parse(MigrationCmsCommand);
    if (!flags['allow-experimental-cms']) {
      throw new SfError('--allow-experimental-cms is required.', 'ExperimentalCmsOptInRequired');
    }
    requireSalesforceId(flags['expected-target-org-id'], 'expected target org ID');
    const target = await Org.create({ aliasOrUsername: flags['target-org'] });
    if (target.getOrgId() !== flags['expected-target-org-id']) {
      throw new SfError('Resolved target org does not match --expected-target-org-id.', 'TargetOrgBindingMismatch');
    }
    const sourcePlanFile = await realpath(resolve(flags['plan-file']));
    const sourcePlanBytes = await readFile(sourcePlanFile);
    const migrationPlan = loadMigrationPlan(sourcePlanBytes);
    if (migrationPlan.targetOrgId !== flags['expected-target-org-id']) {
      throw new SfError('Migration plan target org binding does not match.', 'TargetOrgBindingMismatch');
    }
    const cms = migrationPlan.cmsPlanning;
    if (!cms || cms.state === 'failed') throw new SfError('Migration plan has no usable CMS planning evidence.', 'CmsPlanMissing');
    const packages = new Map(cms.packages.map((item) => [item.sourceWorkspaceId, item]));
    const routes = cms.routes
      .filter(
        (route) =>
          route.state === 'ready-for-execution' &&
          route.status === 'success' &&
          typeof route.targetWorkspaceId === 'string' &&
          route.targetWorkspaceId.length > 0 &&
          typeof route.packageManifestSha256 === 'string' &&
          route.packageManifestSha256.length > 0
      )
      .flatMap((route) => {
        const packageEvidence = packages.get(route.sourceWorkspaceId);
        if (!packageEvidence || packageEvidence.packageManifestSha256 !== route.packageManifestSha256) return [];
        return [
          {
            sourceWorkspaceId: route.sourceWorkspaceId,
            targetWorkspaceId: route.targetWorkspaceId,
            sourceDirectory: resolve(packageEvidence.artifactPath),
            packageManifestSha256: route.packageManifestSha256,
          },
        ];
      });
    if (routes.length === 0) {
      throw new SfError('Migration plan has no executable CMS routes.', 'CmsRouteNotExecutable');
    }
    const executionPlan = await cmsExecutionServices.buildPlan({
      sourcePlanFile,
      sourcePlanSha256: createHash('sha256').update(sourcePlanBytes).digest('hex'),
      targetOrg: flags['target-org'],
      targetOrgId: flags['expected-target-org-id'],
      workspaceMapSha256: cms.workspaceMap.sha256,
      routes,
      reportRoot: resolve(flags['report-root']),
    });
    const result = await cmsExecutionServices.executePlan({
      plan: executionPlan,
      targetOrg: target,
      apply: flags.apply,
      allowExperimental: flags['allow-experimental-cms'],
    });
    await cmsExecutionServices.writeResult(resolve(flags['result-file']), result);
    return result;
  }
}

function loadMigrationPlan(bytes: Buffer): MigrationPlan {
  const value = JSON.parse(bytes.toString('utf8')) as MigrationPlan;
  if (value.schemaVersion !== 1 || value.mode !== 'read-only') {
    throw new SfError('Migration plan contract is unsupported.', 'InvalidMigrationPlan');
  }
  return value;
}

function requireSalesforceId(value: string, label: string): void {
  if (!/^[A-Za-z0-9]{18}$/u.test(value)) {
    throw new SfError(`${label} must be an exact 18-character Salesforce ID.`, 'InvalidSalesforceId');
  }
}
