import type { Connection } from '@salesforce/core';
import { readCampaignFile } from '../campaign/file.js';
import { removeCampaigns, type CampaignToRemove } from '../campaign/remove.js';
import { emptyEnvelope, type Envelope, type Item } from '../envelope.js';
import { apiNameOfFlowFile } from '../flow/file.js';
import { removeFlows, type FlowToRemove } from '../flow/remove.js';
import { cmsExitCodeOf, cmsRemove, type CmsRemoveOptions } from '../libraries.js';
import {
  hasProblem,
  messageOf,
  newPhase,
  notAttempted,
  orgIdOf,
  recordCms,
  refuse,
  selectForWrite,
  withPhase,
  type CmsGroup,
  type McnextSelection,
  type Phase,
} from './shared.js';

export type RemoveOptions = {
  metadata?: string[];
  sourceDirs?: string[];
  /** Folder that holds `cms/` and `mcnext/`. */
  projectDir: string;
  /** Report what would be deleted; delete nothing. */
  preview: boolean;
  /** Without it (and without `preview`) nothing is read or deleted. */
  confirmDelete: boolean;
  /** CMS workspace of the CMS selectors. */
  workspace?: string;
  keepLocalFiles: boolean;
};

export type RemoveDeps = {
  removeFlows: typeof removeFlows;
  removeCampaigns: typeof removeCampaigns;
  cmsRemove: typeof cmsRemove;
  cmsExitCodeOf: typeof cmsExitCodeOf;
};

const DEFAULT_DEPS: RemoveDeps = { removeFlows, removeCampaigns, cmsRemove, cmsExitCodeOf };

/** The calls of one run; each is made once in preview and once for real. */
type Plan = {
  connection: Connection;
  deps: RemoveDeps;
  groups: CmsGroup[];
  hasFlows: boolean;
  hasCampaigns: boolean;
  flows: (preview: boolean) => Parameters<typeof removeFlows>[1];
  campaigns: (preview: boolean) => Parameters<typeof removeCampaigns>[1];
  cms: (group: CmsGroup, preview: boolean) => CmsRemoveOptions;
};

type Checked = { phase: Phase; flows: Item[]; campaigns: Item[]; cms: Item[][] };

/**
 * A campaign is deleted by the name in its file, which the file name only resembles. A campaign
 * selected by a file keeps that file: it names the business unit and is the one to remove. For
 * `-m campaign:Name` the campaign service looks for the project file named after it.
 */
async function campaignsOf(
  own: McnextSelection
): Promise<{ ok: true; campaigns: CampaignToRemove[] } | { ok: false; message: string }> {
  const campaigns: CampaignToRemove[] = own.campaignNames.map((name) => ({ name }));
  for (const file of own.campaignFiles) {
    try {
      // eslint-disable-next-line no-await-in-loop -- a handful of local files
      campaigns.push({ name: (await readCampaignFile(file)).name, path: file });
    } catch (error) {
      return { ok: false, message: `${file}: ${messageOf(error)}` };
    }
  }
  return { ok: true, campaigns };
}

/** Phase 1: every area in preview. Nothing is deleted. */
async function check(plan: Plan): Promise<Checked> {
  const { connection, deps } = plan;
  const checked: Checked = { phase: newPhase(), flows: [], campaigns: [], cms: [] };
  if (plan.hasFlows) checked.flows = await deps.removeFlows(connection, plan.flows(true));
  if (plan.hasCampaigns) checked.campaigns = await deps.removeCampaigns(connection, plan.campaigns(true));
  checked.phase.items.push(...checked.flows, ...checked.campaigns);
  for (const group of plan.groups) {
    // One workspace after the other: the areas never run in parallel.
    // eslint-disable-next-line no-await-in-loop -- sequential by design
    const result = await deps.cmsRemove(connection, plan.cms(group, true));
    checked.cms.push(recordCms(checked.phase, result, deps.cmsExitCodeOf(result)));
  }
  return checked;
}

/** Phase 2: flows, campaigns, CMS content. Stops at the first area with a problem. */
async function write(plan: Plan, checked: Checked): Promise<Phase> {
  const { connection, deps } = plan;
  const phase = newPhase();
  let stopped = false;
  if (plan.hasFlows) {
    const items = await deps.removeFlows(connection, plan.flows(false));
    phase.items.push(...items);
    stopped = hasProblem(items);
  }
  if (plan.hasCampaigns && stopped) phase.items.push(...notAttempted(checked.campaigns));
  else if (plan.hasCampaigns) {
    const items = await deps.removeCampaigns(connection, plan.campaigns(false));
    phase.items.push(...items);
    stopped = hasProblem(items);
  }
  for (const [index, group] of plan.groups.entries()) {
    if (stopped) phase.items.push(...notAttempted(checked.cms[index]));
    else {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      const result = await deps.cmsRemove(connection, plan.cms(group, false));
      const code = deps.cmsExitCodeOf(result);
      stopped = hasProblem(recordCms(phase, result, code)) || code !== 0;
    }
  }
  return phase;
}

/**
 * Delete flows, campaigns and CMS content, in that order (the reverse of a deploy).
 *
 * Every area is checked in preview first; any problem there, and nothing is deleted. The real run
 * stops at the first area that reports a failed, blocked or unknown component; what comes after
 * is `not-attempted`. Nothing is printed and nothing is thrown for a failing component.
 */
export async function remove(
  connection: Connection,
  options: RemoveOptions,
  deps: RemoveDeps = DEFAULT_DEPS
): Promise<Envelope> {
  const envelope = emptyEnvelope('delete', options.preview, orgIdOf(connection));
  const { projectDir, keepLocalFiles } = options;
  if (!options.confirmDelete && !options.preview)
    return refuse(
      envelope,
      'CONFIRM_DELETE_REQUIRED',
      'A delete needs --confirm-delete. Use --preview to see what would be deleted. Nothing was read or deleted.'
    );
  const selection = await selectForWrite(envelope, { verb: 'delete', ...options });
  if (!selection.ok) return selection.envelope;
  const { own, groups } = selection.selected;
  const selectedCampaigns = await campaignsOf(own);
  if (!selectedCampaigns.ok) return refuse(envelope, 'CAMPAIGN_FILE_INVALID', selectedCampaigns.message, 'mcnext');
  const { campaigns } = selectedCampaigns;
  const flows: FlowToRemove[] = own.flowFiles.flatMap((file) => {
    const name = apiNameOfFlowFile(file);
    return name === undefined ? [] : [{ name, path: file }];
  });

  const plan: Plan = {
    connection,
    deps,
    groups,
    hasFlows: flows.length > 0,
    hasCampaigns: campaigns.length > 0,
    flows: (preview) => ({ flows, preview, projectDir, keepLocalFiles }),
    campaigns: (preview) => ({ campaigns, preview, projectDir, keepLocalFiles }),
    cms: (group, preview) => ({
      workspace: group.workspace,
      ...(group.metadata.length > 0 ? { metadata: group.metadata } : {}),
      ...(group.sourceDirs.length > 0 ? { sourceDirs: group.sourceDirs } : {}),
      projectDirectory: projectDir,
      preview,
      keepLocalFiles,
    }),
  };

  const checked = await check(plan);
  if (options.preview) return withPhase(envelope, checked.phase);
  if (hasProblem(checked.phase.items) || checked.phase.codes.some((code) => code !== 0))
    return withPhase(
      { ...envelope, warnings: ['Nothing was deleted: the check before the delete found a problem.'] },
      checked.phase
    );
  return withPhase(envelope, await write(plan, checked));
}
