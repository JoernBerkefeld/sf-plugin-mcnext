import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { parseStringPromise } from 'xml2js';
import { runCore, parseFlowResult, type CoreRunner, type FlowResult } from './flowCli.js';

export type FlowCreateSelection = {
  projectRoot: string;
  targetOrg: string;
  expectedOrgId: string;
  member: string;
  sourceFile: string;
  /** Caller-verified provenance and reference reuse; no cross-org mapping is implemented. */
  sourceOrgId: string;
  reuseSameOrgReferences: boolean;
  waitMinutes?: number;
};

export type FlowUpdateSelection = FlowCreateSelection & {
  expectedDefinitionId: string;
  expectedLatestVersionId: string;
};
type FlowQuery = (soql: string, tooling?: boolean) => Promise<Array<Record<string, unknown>>>;

async function assertOrgIdentity(query: FlowQuery, expected: string): Promise<void> {
  const rows = await query('SELECT Id FROM Organization');
  if (rows.length !== 1 || rows[0].Id !== expected) throw new Error('Target org identity mismatch');
}

/** Fail closed on missing, active, replaced or concurrently edited target versions. */
async function assertUpdateBaseline(selection: FlowUpdateSelection, query: FlowQuery): Promise<string> {
  const rows = await query(
    `SELECT Id, LatestVersionId, ActiveVersionId FROM FlowDefinition WHERE DeveloperName = '${selection.member}'`,
    true
  );
  if (rows.length !== 1) throw new Error('UPDATE target missing or ambiguous; no CREATE fallback');
  const row = rows[0];
  if (row.Id !== selection.expectedDefinitionId || row.LatestVersionId !== selection.expectedLatestVersionId)
    throw new Error('UPDATE target identity mismatch');
  if (row.ActiveVersionId !== null) throw new Error('UPDATE refuses an active Flow definition');
  const versions = await query(
    `SELECT Id, Status, LastModifiedDate FROM Flow WHERE Id = '${selection.expectedLatestVersionId}'`,
    true
  );
  if (
    versions.length !== 1 ||
    versions[0].Id !== selection.expectedLatestVersionId ||
    !['Draft', 'InvalidDraft'].includes(String(versions[0].Status)) ||
    typeof versions[0].LastModifiedDate !== 'string'
  )
    throw new Error('UPDATE requires a verified inactive target baseline');
  return JSON.stringify([
    row.Id,
    row.LatestVersionId,
    row.ActiveVersionId,
    versions[0].Status,
    versions[0].LastModifiedDate,
  ]);
}

/** UPDATE only: immutable source transport with an exact existing inactive target. */
export async function updateFlow(selection: FlowUpdateSelection, runner: CoreRunner = runCore): Promise<FlowResult> {
  if (
    !/^300[A-Za-z0-9]{15}$/.test(selection.expectedDefinitionId) ||
    !/^301[A-Za-z0-9]{15}$/.test(selection.expectedLatestVersionId)
  )
    throw new Error('UPDATE requires expected 18-character definition and latest version IDs');
  return deployInactiveFlow(selection, runner, selection);
}

/** Inspect with a standard XML parser; deploy the original bytes, never reserialize or execute. */
export async function assertInactiveFlowSource(xml: string): Promise<void> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported Flow XML declarations');
  const document = (await parseStringPromise(xml, { explicitArray: true, strict: true })) as Record<string, unknown>;
  const flow = document.Flow as Record<string, unknown> | undefined;
  const attributes = flow?.$ as Record<string, unknown> | undefined;
  if (
    Object.keys(document).length !== 1 ||
    !flow ||
    attributes?.xmlns !== 'http://soap.sforce.com/2006/04/metadata' ||
    !Array.isArray(flow.status) ||
    flow.status.length !== 1 ||
    !['Draft', 'InvalidDraft'].includes(String(flow.status[0])) ||
    !Array.isArray(flow.processType) ||
    flow.processType.length !== 1 ||
    flow.processType[0] !== 'AutoLaunchedFlow' ||
    flow.activeVersionNumber !== undefined
  ) {
    throw new Error(
      'Unsupported Flow source: require one inactive Draft or InvalidDraft AutoLaunchedFlow, never an active definition'
    );
  }
}

/** CREATE only: exact identity, verified org, two absence checks and isolated immutable source selection. */
function validateSelection(selection: FlowCreateSelection): number {
  if (
    !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(selection.member) ||
    selection.member.endsWith('_') ||
    selection.member.includes('__')
  )
    throw new Error(
      'CREATE requires an explicit valid Flow API name (maximum 80 characters, no trailing or consecutive underscores)'
    );
  if (selection.sourceOrgId !== selection.expectedOrgId || selection.reuseSameOrgReferences !== true)
    throw new Error(
      'CREATE requires verified same-org source provenance and explicit reference reuse; cross-org reference mapping is unsupported'
    );
  if (!/^00D[A-Za-z0-9]{15}$/.test(selection.expectedOrgId))
    throw new Error('Expected 18-character org identity is required');
  if (!selection.targetOrg.trim() || selection.targetOrg.startsWith('-') || selection.targetOrg.includes('\0'))
    throw new Error('Explicit target org is required');
  const wait = selection.waitMinutes ?? 10;
  if (!Number.isSafeInteger(wait) || wait < 1 || wait > 30) throw new Error('Wait must be 1–30 minutes');
  return wait;
}

/** Validate inactive source and delegate an isolated deployment; Core has no atomic create-only guarantee. */
export async function createFlow(selection: FlowCreateSelection, runner: CoreRunner = runCore): Promise<FlowResult> {
  return deployInactiveFlow(selection, runner);
}

async function deployInactiveFlow(
  selection: FlowCreateSelection,
  runner: CoreRunner,
  update?: FlowUpdateSelection
): Promise<FlowResult> {
  const operation = update ? 'update' : 'create';
  const wait = validateSelection(selection);
  const projectRoot = resolve(selection.projectRoot);
  const project = JSON.parse(await readFile(join(projectRoot, 'sfdx-project.json'), 'utf8')) as {
    packageDirectories?: Array<{ path: string }>;
    sourceApiVersion?: string;
  };
  if (!Array.isArray(project.packageDirectories) || !project.packageDirectories.length)
    throw new Error('Configured packageDirectories required');
  const sourceFile = resolve(projectRoot, selection.sourceFile);
  const owner = project.packageDirectories.find((entry) => {
    if (
      typeof entry.path !== 'string' ||
      !entry.path ||
      isAbsolute(entry.path) ||
      entry.path.split(/[\\/]/).includes('..')
    )
      return false;
    const rel = relative(resolve(projectRoot, entry.path), sourceFile);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!owner || !sourceFile.endsWith('.flow-meta.xml'))
    throw new Error('Flow source must belong to a configured relative package directory');
  const xml = await readFile(sourceFile, 'utf8');
  await assertInactiveFlowSource(xml);
  const query = async (soql: string, tooling = false): Promise<Array<Record<string, unknown>>> => {
    const result = await runner(
      [
        'data',
        'query',
        '--target-org',
        selection.targetOrg,
        ...(tooling ? ['--use-tooling-api'] : []),
        '--query',
        soql,
        '--json',
      ],
      projectRoot
    );
    const value = JSON.parse(result.stdout) as {
      status?: number;
      result?: { records?: Array<Record<string, unknown>>; totalSize?: number; done?: boolean };
    };
    if (
      result.exitCode !== 0 ||
      value.status !== 0 ||
      value.result?.done !== true ||
      !Array.isArray(value.result.records) ||
      value.result.totalSize !== value.result.records.length
    )
      throw new Error('Incomplete Core identity/absence query');
    return value.result.records;
  };
  await assertOrgIdentity(query, selection.expectedOrgId);
  const absent = async (): Promise<void> => {
    const rows = await query(`SELECT Id FROM FlowDefinition WHERE DeveloperName = '${selection.member}'`, true);
    if (rows.length) throw new Error('Flow identity already exists; CREATE will not update or overwrite');
  };
  const baseline = update ? await assertUpdateBaseline(update, query) : await absent();
  const scratch = await mkdtemp(join(tmpdir(), 'mcnext-flow-create-'));
  let outcome: FlowResult | undefined;
  let failure: unknown;
  try {
    const folder = join(scratch, owner.path, 'main', 'default', 'flows');
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(scratch, 'sfdx-project.json'),
      JSON.stringify({
        packageDirectories: [{ path: owner.path, default: true }],
        sourceApiVersion: project.sourceApiVersion ?? '67.0',
      })
    );
    await writeFile(join(folder, `${selection.member}.flow-meta.xml`), xml);
    const args = [
      'project',
      'deploy',
      'start',
      '--target-org',
      selection.targetOrg,
      '--metadata',
      `Flow:${selection.member}`,
      '--wait',
      String(wait),
      '--json',
    ];
    const base = {
      projectRoot: scratch,
      targetOrg: selection.targetOrg,
      members: [selection.member],
      waitMinutes: wait,
    };
    const validation = parseFlowResult(
      { ...base, operation: 'validate' },
      await runner([...args, '--dry-run'], scratch)
    );
    if (validation.state !== 'succeeded')
      throw new Error(`Validation pending (${validation.jobId}); ${operation.toUpperCase()} not started`);
    if (update) {
      await assertOrgIdentity(query, selection.expectedOrgId);
      if ((await assertUpdateBaseline(update, query)) !== baseline)
        throw new Error('UPDATE baseline changed during validation; no deployment started');
    } else await absent();
    outcome = parseFlowResult({ ...base, operation }, await runner(args, scratch));
    outcome.diagnostics = [...(validation.diagnostics ?? []), ...(outcome.diagnostics ?? [])];
  } catch (error) {
    failure = error;
  }
  try {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    throw new Error(
      `Flow outcome: ${
        failure ? String(failure) : JSON.stringify(outcome)
      }; scratch cleanup failed at ${scratch}: ${String(error)}`
    );
  }
  if (failure) throw failure;
  return outcome!;
}
