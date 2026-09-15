import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Messages, Org, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { runCmsExport, runCmsInfo } from '../../../cms/cmsCli.js';
import type { CmsDiagnostic, CmsExportWorkspace } from '../../../cms/contracts.js';
import { validateCmsPackageEvidence } from '../../../cms/packageIntegrity.js';
import {
  buildCmsPlanningState,
  buildFailedCmsPlanningState,
  type CmsPlanningRouteEvidence,
  type CmsPlanningState,
  parseCmsWorkspaceMap,
} from '../../../migration/cmsPlanning.js';
import {
  buildMigrationPlan,
  OpaqueCmsDependency,
  runMigrationPreflight,
  writeMigrationPlan,
} from '../../../migration/migrationPlan.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.migration.plan');

export const cmsPlanningServices = {
  runInfo: runCmsInfo,
  runExport: runCmsExport,
  validatePackage: validateCmsPackageEvidence,
};

export type MigrationPlanResult = {
  outputFile: string;
  sourceOrgId: string;
  targetOrgId: string;
  preflightPassed: boolean;
  inventoryItems: number;
  deferredCmsDependencies: number;
  cmsPlanning?: {
    state: CmsPlanningState['state'];
    experimental: boolean;
    readyRoutes: number;
    blockedRoutes: number;
  };
  readOnly: true;
};

export default class MigrationPlanCommand extends SfCommand<MigrationPlanResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:migration:plan'];

  public static readonly flags = {
    'source-org': Flags.string({
      required: true,
      summary: messages.getMessage('flags.source-org.summary'),
    }),
    'target-org': Flags.string({
      // eslint-disable-next-line sf-plugin/dash-o -- target-org convention intentionally uses -o
      char: 'o',
      required: true,
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'output-file': Flags.string({
      required: true,
      summary: messages.getMessage('flags.output-file.summary'),
    }),
    'cms-evidence-file': Flags.string({
      summary: messages.getMessage('flags.cms-evidence-file.summary'),
    }),
    'cms-plan': Flags.boolean({
      summary: messages.getMessage('flags.cms-plan.summary'),
    }),
    'cms-workspace-map': Flags.string({
      summary: messages.getMessage('flags.cms-workspace-map.summary'),
    }),
    'cms-export-dir': Flags.string({
      summary: messages.getMessage('flags.cms-export-dir.summary'),
    }),
  };

  public async run(): Promise<MigrationPlanResult> {
    const { flags } = await this.parse(MigrationPlanCommand);
    const source = await Org.create({ aliasOrUsername: flags['source-org'] });
    const target = await Org.create({ aliasOrUsername: flags['target-org'] });
    const preflight = await runMigrationPreflight(source, target);
    const deferredCmsDependencies = flags['cms-evidence-file'] ? await readCmsEvidence(flags['cms-evidence-file']) : [];
    const cmsPlanning = await planCmsMigration(flags, source);
    const plan = buildMigrationPlan({
      sourceOrgId: source.getOrgId(),
      targetOrgId: target.getOrgId(),
      preflight,
      deferredCmsDependencies,
      ...(cmsPlanning === undefined ? {} : { cmsPlanning }),
    });

    await writeMigrationPlan(plan, flags['output-file']);
    this.table({ data: preflight, title: 'Migration prerequisite preflight' });

    const blocked = preflight.filter((check) => check.status === 'blocked');
    if (blocked.length > 0) {
      this.warn(messages.getMessage('warnings.blocked', [blocked.length]));
    }

    if (cmsPlanning !== undefined) {
      this.log(
        messages.getMessage('info.cmsPlanning', [
          cmsPlanning.state,
          cmsPlanning.experimental ? 'experimental' : 'not experimental',
          cmsPlanning.routes.filter((route) => route.state === 'ready-for-execution').length,
          cmsPlanning.routes.filter((route) => route.state !== 'ready-for-execution').length,
        ])
      );
      if (cmsPlanning.state !== 'ready-for-execution') this.warn(messages.getMessage('warnings.cmsPlanning'));
    }

    return {
      outputFile: flags['output-file'],
      sourceOrgId: plan.sourceOrgId,
      targetOrgId: plan.targetOrgId,
      preflightPassed: blocked.length === 0,
      inventoryItems: plan.inventory.length,
      deferredCmsDependencies: plan.deferredCmsDependencies.length,
      ...(cmsPlanning === undefined
        ? {}
        : {
            cmsPlanning: {
              state: cmsPlanning.state,
              experimental: cmsPlanning.experimental,
              readyRoutes: cmsPlanning.routes.filter((route) => route.state === 'ready-for-execution').length,
              blockedRoutes: cmsPlanning.routes.filter((route) => route.state !== 'ready-for-execution').length,
            },
          }),
      readOnly: true,
    };
  }
}

type MigrationPlanFlags = {
  'source-org': string;
  'target-org': string;
  'output-file': string;
  'cms-evidence-file'?: string;
  'cms-plan': boolean;
  'cms-workspace-map'?: string;
  'cms-export-dir'?: string;
};

// eslint-disable-next-line complexity -- orchestration keeps invalid input throws separate from bounded provider failure state
async function planCmsMigration(flags: MigrationPlanFlags, source: Org): Promise<CmsPlanningState | undefined> {
  const companionPresent = flags['cms-workspace-map'] !== undefined || flags['cms-export-dir'] !== undefined;
  if (!flags['cms-plan']) {
    if (companionPresent) {
      throw new SfError('--cms-workspace-map and --cms-export-dir require --cms-plan.', 'InvalidCmsPlanningFlagsError');
    }
    return undefined;
  }
  if (!flags['cms-workspace-map'] || !flags['cms-export-dir']) {
    throw new SfError('--cms-plan requires --cms-workspace-map and --cms-export-dir.', 'InvalidCmsPlanningFlagsError');
  }

  const workspaceMap = parseCmsWorkspaceMap(await readFile(flags['cms-workspace-map']));
  const exportDirectory = resolve(flags['cms-export-dir']);
  await requireNewExportDirectory(exportDirectory);
  try {
    const info = await cmsPlanningServices.runInfo();
    const envelope = await cmsPlanningServices.runExport(flags['source-org'], exportDirectory);
    if (envelope.result === null) throw new Error('CMS export returned no planning result');
    if (envelope.provenance.sourceOrgId !== source.getOrgId())
      throw new Error('CMS export source org binding mismatch');
    if (envelope.provenance.pluginVersion !== info.envelope.result!.plugin.version) {
      throw new Error('CMS info/export plugin version binding mismatch');
    }

    const routes: CmsPlanningRouteEvidence[] = [];
    const packages = [];
    const correlations = [];
    for (const workspace of envelope.result.workspaces) {
      const targetWorkspaceId = workspaceMap.routes.find(
        (route) => route.sourceWorkspaceId === workspace.source.sourceId
      )?.targetWorkspaceId;
      if (targetWorkspaceId === undefined) {
        routes.push(
          blockedRoute(
            workspace,
            '',
            info.capabilities.experimental,
            'CMS_ROUTE_MISSING',
            'No explicit target workspace route exists.'
          )
        );
        continue;
      }
      if (workspace.status !== 'success' || workspace.diagnostics.errors.length > 0) {
        routes.push(
          blockedRoute(
            workspace,
            targetWorkspaceId,
            info.capabilities.experimental,
            'CMS_EXPORT_INCOMPLETE',
            'CMS workspace export is not successful or reports errors.'
          )
        );
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- package evidence is validated sequentially against one bounded export root
        const evidence = await cmsPlanningServices.validatePackage(exportDirectory, envelope, workspace);
        packages.push(evidence);
        correlations.push(...evidence.correlations);
        routes.push({
          sourceWorkspaceId: workspace.source.sourceId,
          targetWorkspaceId,
          packageManifestSha256: evidence.packageManifestSha256,
          status: workspace.status,
          state: 'ownership-uncertain',
          experimental: info.capabilities.experimental,
          diagnostics: [
            ...workspace.diagnostics.warnings,
            ...workspace.diagnostics.errors,
            diagnostic(
              'CMS_OWNERSHIP_UNCERTAIN',
              'No independently evidenced workspace, owner, and field-bound MCN dependency source is known.'
            ),
          ],
        });
      } catch (error) {
        routes.push(
          blockedRoute(
            workspace,
            targetWorkspaceId,
            info.capabilities.experimental,
            'CMS_PACKAGE_INVALID',
            errorMessage(error)
          )
        );
      }
    }

    const ready = routes.filter((route) => route.state === 'ready-for-execution').length;
    const uncertain = routes.filter((route) => route.state === 'ownership-uncertain').length;
    const blocked = routes.length - ready - uncertain;
    return buildCmsPlanningState({
      state:
        envelope.status !== 'success' || envelope.diagnostics.errors.length > 0
          ? 'blocked'
          : uncertain > 0 && ready === 0 && blocked === 0
          ? 'ownership-uncertain'
          : ready > 0 && blocked === 0 && uncertain === 0 && envelope.status === 'success'
          ? 'ready-for-execution'
          : ready > 0
          ? 'partial'
          : 'blocked',
      capabilities: {
        pluginVersion: info.envelope.result!.plugin.version,
        ...info.capabilities,
      },
      exportProvenance: {
        sourceOrgId: envelope.provenance.sourceOrgId,
        pluginVersion: envelope.provenance.pluginVersion,
        exportSetId: envelope.provenance.exportSetId!,
        command: envelope.provenance.command,
        generatedAt: envelope.provenance.generatedAt,
      },
      workspaceMap,
      packages,
      correlations,
      routes,
      diagnostics: [...envelope.diagnostics.warnings, ...envelope.diagnostics.errors],
    });
  } catch (error) {
    return buildFailedCmsPlanningState(workspaceMap, diagnostic('CMS_PLANNING_FAILED', errorMessage(error)));
  }
}

async function requireNewExportDirectory(directory: string): Promise<void> {
  try {
    await lstat(directory);
    throw new SfError(`CMS export directory must not already exist: ${directory}`, 'InvalidCmsExportDirectoryError');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function blockedRoute(
  workspace: CmsExportWorkspace,
  targetWorkspaceId: string,
  experimental: boolean,
  code: string,
  message: string
): CmsPlanningRouteEvidence {
  return {
    sourceWorkspaceId: workspace.source.sourceId,
    targetWorkspaceId,
    status: workspace.status,
    state: 'blocked',
    experimental,
    diagnostics: [
      ...workspace.diagnostics.warnings,
      ...workspace.diagnostics.errors,
      diagnostic(code, message, workspace.source.sourceId),
    ],
  };
}

function diagnostic(code: string, message: string, scope?: string): CmsDiagnostic {
  return { code, message, ...(scope === undefined ? {} : { scope }) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readCmsEvidence(file: string): Promise<OpaqueCmsDependency[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    throw new SfError(
      `Could not read CMS evidence file ${file}: ${(error as Error).message}`,
      'InvalidCmsEvidenceError'
    );
  }

  if (!Array.isArray(parsed) || !parsed.every(isOpaqueCmsDependency)) {
    throw new SfError(
      'CMS evidence must be an array containing only owner, status, sourceReference, and blockedOperation strings.',
      'InvalidCmsEvidenceError'
    );
  }
  return parsed;
}

function isOpaqueCmsDependency(value: unknown): value is OpaqueCmsDependency {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === 'blockedOperation,owner,sourceReference,status' &&
    record.owner === 'cms-service' &&
    record.status === 'deferred: cms-service-contract' &&
    typeof record.sourceReference === 'string' &&
    typeof record.blockedOperation === 'string'
  );
}
