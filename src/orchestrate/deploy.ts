import type { Connection } from '@salesforce/core';
import { pickWorkspace, resolveBusinessUnit, type TargetScope } from '../business-units.js';
import { deployCampaigns } from '../campaign/deploy.js';
import { campaignFilesNamed, campaignKey, campaignPath, readCampaignFile } from '../campaign/file.js';
import { emptyEnvelope, type Envelope, type Item } from '../envelope.js';
import { deployFlows, type DeployFlowsOptions } from '../flow/deploy.js';
import { cmsDeploy, cmsExitCodeOf, type CmsDeployOptions } from '../libraries.js';
import {
  cmsWorkspaceOf,
  hasProblem,
  isProblem,
  newPhase,
  notAttempted,
  orgIdOf,
  recordCms,
  refuse,
  selectForWrite,
  withPhase,
  type CmsGroup,
  type Phase,
} from './shared.js';

export type DeployOptions = {
  metadata?: string[];
  sourceDirs?: string[];
  /** Folder that holds `cms/` and `mcnext/`. */
  projectDir: string;
  /** Check everything and report what would happen; write nothing. */
  preview: boolean;
  /** Developer name of the business unit a copy goes to. */
  businessUnit?: string;
  /** CMS workspace everything goes to. */
  workspace?: string;
  /** Data space the flows and the CMS data graph providers go to. */
  dataspace?: string;
  allowCrossDataspace: boolean;
  allowActivation: boolean;
};

export type DeployDeps = {
  resolveBusinessUnit: typeof resolveBusinessUnit;
  deployCampaigns: typeof deployCampaigns;
  deployFlows: (...args: [Parameters<typeof deployFlows>[0], Parameters<typeof deployFlows>[1]]) => Promise<Item[]>;
  cmsDeploy: typeof cmsDeploy;
  cmsExitCodeOf: typeof cmsExitCodeOf;
};

const DEFAULT_DEPS: DeployDeps = { resolveBusinessUnit, deployCampaigns, deployFlows, cmsDeploy, cmsExitCodeOf };

type CmsTarget = CmsGroup & { target: string };

/** The calls of one run; each is made once in preview and once for real. */
type Plan = {
  connection: Connection;
  deps: DeployDeps;
  targets: CmsTarget[];
  hasCampaigns: boolean;
  hasFlows: boolean;
  metInThisRun: DeployFlowsOptions['metInThisRun'];
  /** Developer name of the business unit every campaign of the run goes to; undefined: each file's own. */
  campaignTarget?: string;
  cms: (target: CmsTarget, preview: boolean) => CmsDeployOptions;
  campaigns: (preview: boolean) => Parameters<typeof deployCampaigns>[1];
  flows: (preview: boolean) => DeployFlowsOptions;
};

type Checked = { phase: Phase; cms: Item[][]; campaigns: Item[]; flows: Item[] };

/** The CMS workspace each group goes to: its own, or the one of the target business unit. */
function targetsOf(
  groups: CmsGroup[],
  scope: TargetScope | undefined,
  explicit: string | undefined
): { ok: true; targets: CmsTarget[] } | { ok: false; code: string; message: string } {
  const targets: CmsTarget[] = [];
  for (const group of groups) {
    if (scope) {
      const picked = pickWorkspace(scope.workspaces, group.workspace, explicit);
      if (!picked.ok) return picked;
      targets.push({ ...group, target: picked.workspace });
    } else targets.push({ ...group, target: group.workspace });
  }
  return { ok: true, targets };
}

/** Where the flows go when the run names a target: a business unit, `--dataspace` or `--workspace`. */
function flowTargetOf(options: DeployOptions, scope: TargetScope | undefined): DeployFlowsOptions['target'] {
  if (!scope && options.dataspace === undefined && options.workspace === undefined) return undefined;
  const dataSpace = options.dataspace ?? scope?.dataSpace;
  return {
    ...(dataSpace ? { dataSpace } : {}),
    workspaceFor: (source: string): string | undefined => {
      if (!scope) return options.workspace ?? source;
      const picked = pickWorkspace(scope.workspaces, source, options.workspace);
      return picked.ok ? picked.workspace : undefined;
    },
  };
}

/** The files of `-m campaign:Name`: every project file named after it; without one, the file it would have. */
async function campaignFilesOfNames(projectDir: string, names: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop -- a handful of local folders
    const found = await campaignFilesNamed(projectDir, name);
    files.push(...(found.length > 0 ? found : [campaignPath(projectDir, name)]));
  }
  return files;
}

/** Key of the campaign an item of the check stands for: the business unit it goes to and its name. */
async function campaignKeyOf(item: Item, target: string | undefined): Promise<string> {
  if (target !== undefined || item.path === undefined) return campaignKey(target, item.name);
  try {
    return campaignKey((await readCampaignFile(item.path)).businessUnit?.developerName, item.name);
  } catch {
    return campaignKey(null, item.name);
  }
}

/** Phase 1: every area in preview. Nothing is written. */
async function check(plan: Plan): Promise<Checked> {
  const { connection, deps, metInThisRun } = plan;
  const checked: Checked = { phase: newPhase(), cms: [], campaigns: [], flows: [] };
  for (const target of plan.targets) {
    // One workspace after the other: the areas never run in parallel.
    // eslint-disable-next-line no-await-in-loop -- sequential by design
    const result = await deps.cmsDeploy(connection, plan.cms(target, true));
    const items = recordCms(checked.phase, result, deps.cmsExitCodeOf(result));
    checked.cms.push(items);
    // What this run creates counts as met for the flows, under the name the flows use.
    for (const item of items.filter((candidate) => !isProblem(candidate))) {
      for (const workspace of new Set([cmsWorkspaceOf(result) ?? target.target, target.target]))
        metInThisRun.content.add(`${workspace}/${item.type}/${item.name}`);
    }
  }
  if (plan.hasCampaigns) checked.campaigns = await deps.deployCampaigns(connection, plan.campaigns(true));
  for (const item of checked.campaigns.filter((candidate) => !isProblem(candidate))) {
    // eslint-disable-next-line no-await-in-loop -- a handful of local files
    metInThisRun.campaigns.add(await campaignKeyOf(item, plan.campaignTarget));
  }
  if (plan.hasFlows) checked.flows = await deps.deployFlows(connection, plan.flows(true));
  checked.phase.items.push(...checked.campaigns, ...checked.flows);
  return checked;
}

/** Phase 2: CMS content, campaigns, flows with their links. Stops at the first area with a problem. */
async function write(plan: Plan, checked: Checked): Promise<Phase> {
  const { connection, deps } = plan;
  const phase = newPhase();
  let stopped = false;
  for (const [index, target] of plan.targets.entries()) {
    if (stopped) phase.items.push(...notAttempted(checked.cms[index]));
    else {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      const result = await deps.cmsDeploy(connection, plan.cms(target, false));
      const code = deps.cmsExitCodeOf(result);
      stopped = hasProblem(recordCms(phase, result, code)) || code !== 0;
    }
  }
  if (plan.hasCampaigns && stopped) phase.items.push(...notAttempted(checked.campaigns));
  else if (plan.hasCampaigns) {
    const items = await deps.deployCampaigns(connection, plan.campaigns(false));
    phase.items.push(...items);
    stopped = hasProblem(items);
  }
  if (plan.hasFlows && stopped) phase.items.push(...notAttempted(checked.flows));
  else if (plan.hasFlows) phase.items.push(...(await deps.deployFlows(connection, plan.flows(false))));
  return phase;
}

/**
 * Deploy CMS content, campaigns, flows and the flows' campaign links, in that order.
 *
 * Every area is checked in preview first; a flow's need counts as met when this run creates it.
 * Any problem there, and nothing is written. The real run stops at the first area that reports a
 * failed, blocked or unknown component; what comes after is `not-attempted`. Nothing is printed
 * and nothing is thrown for a failing component.
 */
export async function deploy(
  connection: Connection,
  options: DeployOptions,
  deps: DeployDeps = DEFAULT_DEPS
): Promise<Envelope> {
  const envelope = emptyEnvelope('deploy', options.preview, orgIdOf(connection));
  const { projectDir } = options;
  const selection = await selectForWrite(envelope, { verb: 'deploy', ...options });
  if (!selection.ok) return selection.envelope;
  const { own, groups } = selection.selected;

  let scope: TargetScope | undefined;
  if (options.businessUnit) {
    const resolved = await deps.resolveBusinessUnit(connection, options.businessUnit);
    if (!resolved.ok) return refuse(envelope, resolved.code, resolved.message);
    scope = resolved.scope;
  }
  const placed = targetsOf(groups, scope, options.workspace);
  if (!placed.ok) return refuse(envelope, placed.code, placed.message, 'cms');

  const dataSpace = options.dataspace ?? scope?.dataSpace;
  const campaignFiles = [
    ...new Set([...(await campaignFilesOfNames(projectDir, own.campaignNames)), ...own.campaignFiles]),
  ];
  const targetBusinessUnit = scope
    ? { id: scope.businessUnit.id, developerName: scope.businessUnit.developerName }
    : undefined;
  const flowTarget = flowTargetOf(options, scope);
  const metInThisRun = { content: new Set<string>(), campaigns: new Set<string>(), segments: new Set<string>() };
  const plan: Plan = {
    connection,
    deps,
    targets: placed.targets,
    hasCampaigns: campaignFiles.length > 0,
    hasFlows: own.flowFiles.length > 0,
    metInThisRun,
    ...(targetBusinessUnit ? { campaignTarget: targetBusinessUnit.developerName } : {}),
    cms: (target, preview) => ({
      workspace: target.target,
      ...(target.metadata.length > 0 ? { metadata: target.metadata } : {}),
      ...(target.sourceDirs.length > 0 ? { sourceDirs: target.sourceDirs } : {}),
      projectDirectory: projectDir,
      preview,
      ...(dataSpace ? { dataspace: dataSpace } : {}),
      ...(options.allowCrossDataspace ? { allowCrossDataspace: true } : {}),
    }),
    campaigns: (preview) => ({ files: campaignFiles, preview, ...(targetBusinessUnit ? { targetBusinessUnit } : {}) }),
    flows: (preview) => ({
      files: own.flowFiles,
      preview,
      allowActivation: options.allowActivation,
      ...(flowTarget ? { target: flowTarget } : {}),
      metInThisRun,
    }),
  };

  const checked = await check(plan);
  if (options.preview) return withPhase(envelope, checked.phase);
  if (hasProblem(checked.phase.items) || checked.phase.codes.some((code) => code !== 0))
    return withPhase(
      { ...envelope, warnings: ['Nothing was written: the check before the deploy found a problem.'] },
      checked.phase
    );
  return withPhase(envelope, await write(plan, checked));
}
