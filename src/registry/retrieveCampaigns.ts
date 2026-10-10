import filesystem from 'node:fs/promises';
import { join, relative } from 'node:path';
import { redact } from '../cms/cmsCli.js';
import { runCampaign, type CampaignResult } from '../core/campaignCli.js';
import { runCore, type CoreRunner } from '../core/flowCli.js';
import { inspectDestination, validateComponents, validateRetrievalProject } from './retrieve-resolver.js';

export type CampaignRetrievalContext = {
  projectRoot: string;
  targetOrg: string;
  expectedOrgId: string;
  apiVersion: string;
};
type State = 'success' | 'partial' | 'blocked' | 'failed';
export type CampaignSnapshotsResult = {
  state: State;
  files: string[];
  diagnostics: string[];
  campaigns: Array<{
    campaignId: string;
    result?: CampaignResult;
    state: State;
    files: string[];
    diagnostics: string[];
  }>;
};

/** Publish bounded describe-driven flat snapshots; native Flow publication belongs to the coordinator. */
export async function retrieveCampaignSnapshots(
  context: CampaignRetrievalContext,
  core: CoreRunner = runCore
): Promise<CampaignSnapshotsResult> {
  const outcome: CampaignSnapshotsResult = { state: 'blocked', files: [], diagnostics: [], campaigns: [] };
  const progress: { phase: 'preflight' | 'request' | 'validation' } = { phase: 'preflight' };
  const call = async (args: string[]): Promise<Record<string, unknown>> => {
    progress.phase = 'request';
    const response = await core(
      [...args, '--target-org', context.targetOrg, '--api-version', context.apiVersion, '--json'],
      context.projectRoot
    );
    if (response.exitCode !== 0) throw new Error('Core Campaign listing transport failed');
    progress.phase = 'validation';
    const envelope: unknown = JSON.parse(response.stdout);
    if (!object(envelope) || envelope.status !== 0 || !object(envelope.result)) {
      throw new Error('Core Campaign listing failed or returned malformed success');
    }
    return envelope.result;
  };
  try {
    await validateRetrievalProject(context.projectRoot);
    validateContext(context);
    const orgs = completeRows(await call(['data', 'query', '--query', 'SELECT Id FROM Organization']));
    if (orgs.length !== 1 || orgs[0].Id !== context.expectedOrgId)
      throw new Error('Fresh selected org identity mismatch');
    const records = completeRows(
      await call(['data', 'query', '--query', 'SELECT Id FROM Campaign ORDER BY Id LIMIT 101'])
    );
    outcome.campaigns = campaignIds(records).map((campaignId) => ({
      campaignId,
      state: 'blocked',
      files: [],
      diagnostics: [],
    }));
  } catch (error) {
    outcome.state = progress.phase === 'request' ? 'failed' : 'blocked';
    outcome.diagnostics.push(`Campaign enumeration ${progress.phase}: ${safeError(error)}`);
    return outcome;
  }

  const candidates: Array<{ row: CampaignSnapshotsResult['campaigns'][number]; destination: string; bytes: string }> =
    [];
  for (const row of outcome.campaigns) {
    try {
      // eslint-disable-next-line no-await-in-loop -- fresh per-record evidence and deterministic diagnostics
      const result = await runCampaign({ ...context, operation: 'export', recordId: row.campaignId }, core);
      row.result = result;
      if (result.operation !== 'export') throw new Error('Expected Campaign export');
      row.state = result.diagnostics.snapshot === 'complete' ? 'success' : 'partial';
      row.diagnostics.push(
        `Snapshot ${result.diagnostics.snapshot}; omitted fields: ${result.diagnostics.omittedFields.join(', ')}`,
        result.diagnostics.associatedArtifacts.reason,
        ...associationReasons(result.diagnostics.associatedArtifacts.flows)
      );
      // Names are validated together after all reads, before any project writes.
      candidates.push({
        row,
        destination: join(
          context.projectRoot,
          'mcnext',
          'campaigns',
          `${String(result.artifact.Name)}.mcn-campaign.json`
        ),
        bytes: `${JSON.stringify(result.artifact, undefined, 2)}\n`,
      });
    } catch (error) {
      row.state = 'failed';
      row.diagnostics.push(`Campaign snapshot read: ${safeError(error)}`);
    }
  }
  try {
    const names = new Set<string>();
    for (const candidate of candidates) {
      const name = snapshotName(candidate.row.result);
      if (typeof name !== 'string' || !name.trim() || /[\\/]/u.test(name))
        throw new Error('Campaign Name is not portable');
      validateComponents(name);
      const key = name.normalize('NFKC').toLowerCase();
      if (names.has(key)) throw new Error('Campaign Names collide by case or NFKC');
      names.add(key);
      // eslint-disable-next-line no-await-in-loop -- preflight the whole candidate set before any write
      await inspectDestination(context.projectRoot, candidate.destination, true);
    }
  } catch (error) {
    for (const { row } of candidates) {
      row.state = 'blocked';
      row.diagnostics.push(`Campaign publication preflight: ${safeError(error)}`);
    }
    outcome.diagnostics.push(`Campaign publication preflight: ${safeError(error)}`);
    outcome.state = outcome.campaigns.some((row) => row.state === 'failed') ? 'failed' : 'blocked';
    return outcome;
  }
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop -- deterministic exclusive publication and truthful file accounting
      await publishSnapshot(context.projectRoot, candidate.destination, candidate.bytes);
      candidate.row.files.push(candidate.destination);
      outcome.files.push(candidate.destination);
    } catch (error) {
      candidate.row.state = 'failed';
      candidate.row.diagnostics.push(`Campaign publication: ${safeError(error)}`);
      outcome.diagnostics.push(
        `Attempted output (not published): ${relative(context.projectRoot, candidate.destination)}`
      );
      for (const remaining of candidates.slice(candidates.indexOf(candidate) + 1)) {
        remaining.row.state = 'blocked';
        remaining.row.diagnostics.push('Campaign publication stopped after prior write failure');
      }
      break;
    }
  }
  outcome.state = summarize(outcome);
  return outcome;
}

function snapshotName(result: CampaignResult | undefined): unknown {
  return result?.operation === 'export' ? result.artifact.Name : undefined;
}
function associationReasons(flows: Array<{ reason?: string }> = []): string[] {
  return flows.flatMap((flow) => (flow.reason ? [flow.reason] : []));
}
function validateContext(context: CampaignRetrievalContext): void {
  if (
    context.apiVersion !== '67.0' ||
    !context.targetOrg.trim() ||
    context.targetOrg.startsWith('-') ||
    context.targetOrg.includes('\0') ||
    !/^00D[A-Za-z0-9]{15}$/u.test(context.expectedOrgId)
  )
    throw new Error('Campaign retrieval requires explicit selected org identity and API 67.0');
}
function campaignIds(records: Array<Record<string, unknown>>): string[] {
  const ids = new Set<string>();
  for (const record of records) {
    if (typeof record.Id !== 'string' || !/^701[A-Za-z0-9]{15}$/u.test(record.Id) || ids.has(record.Id)) {
      throw new Error('Duplicate or malformed canonical Campaign identity');
    }
    ids.add(record.Id);
  }
  return [...ids];
}
async function publishSnapshot(root: string, destination: string, bytes: string): Promise<void> {
  for (const directory of [join(root, 'mcnext'), join(root, 'mcnext', 'campaigns')]) {
    // eslint-disable-next-line no-await-in-loop -- recheck each parent before nonrecursive creation
    await inspectDestination(root, directory, false);
    try {
      // eslint-disable-next-line no-await-in-loop -- create only checked parents
      await filesystem.mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // eslint-disable-next-line no-await-in-loop -- reject raced-in aliases and links
    await inspectDestination(root, directory, false);
  }
  await inspectDestination(root, destination, true);
  const handle = await filesystem.open(destination, 'wx');
  try {
    await handle.writeFile(bytes, 'utf8');
  } finally {
    await handle.close();
  }
}
function summarize(outcome: CampaignSnapshotsResult): State {
  if (outcome.campaigns.every((row) => row.state === 'success')) return 'success';
  if (outcome.files.length) return 'partial';
  return outcome.campaigns.some((row) => row.state === 'failed') ? 'failed' : 'blocked';
}
function completeRows(value: Record<string, unknown>): Array<Record<string, unknown>> {
  if (
    value.done !== true ||
    !Array.isArray(value.records) ||
    !Number.isSafeInteger(value.totalSize) ||
    value.totalSize !== value.records.length ||
    value.records.length > 100 ||
    !value.records.every(object)
  )
    throw new Error('Incomplete Campaign enumeration (completed count required; maximum 100 rows)');
  return value.records;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
