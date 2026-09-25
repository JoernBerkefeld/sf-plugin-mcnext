import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
  expectUnchanged?: boolean;
};
type FlowQuery = (soql: string, tooling?: boolean) => Promise<Array<Record<string, unknown>>>;

async function assertOrgIdentity(query: FlowQuery, expected: string): Promise<void> {
  const rows = await query('SELECT Id FROM Organization');
  if (rows.length !== 1 || rows[0].Id !== expected) throw new Error('Target org identity mismatch');
}

const NONTERMINAL_DEPLOY_STATUSES = ['Pending', 'InProgress', 'Finalizing', 'Canceling'] as const;

/** Block while any metadata deployment is nonterminal; DeployRequest exposes no component-level correlation. */
async function assertNoPendingDeployments(query: FlowQuery): Promise<void> {
  const statuses = NONTERMINAL_DEPLOY_STATUSES.map((status) => `'${status}'`).join(',');
  const rows = await query(
    `SELECT Id, Status, CheckOnly, CreatedDate FROM DeployRequest WHERE Status IN (${statuses}) ORDER BY CreatedDate DESC LIMIT 20`,
    true
  );
  if (rows.length) throw new Error('A metadata deployment is still nonterminal; Flow mutation is blocked');
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
  await assertNoPendingDeployments(query);
  const absent = async (): Promise<void> => {
    const rows = await query(`SELECT Id FROM FlowDefinition WHERE DeveloperName = '${selection.member}'`, true);
    if (rows.length) throw new Error('Flow identity already exists; CREATE will not update or overwrite');
  };
  const baseline = update ? await assertUpdateBaseline(update, query) : await absent();
  if (update) {
    const baselineXml = await retrieveFlowXml(selection, owner.path, runner, 'baseline');
    await assertUpdateSourceContract(baselineXml, xml, update.expectUnchanged === true);
  }
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
      await assertNoPendingDeployments(query);
      if ((await assertUpdateBaseline(update, query)) !== baseline)
        throw new Error('UPDATE baseline changed during validation; no deployment started');
    } else {
      await assertNoPendingDeployments(query);
      await absent();
    }
    outcome = parseFlowResult({ ...base, operation }, await runner(args, scratch));
    await verifySuccessfulFlowOutcome(outcome, selection, owner.path, xml, scratch, runner, query, update);
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

async function verifySuccessfulFlowOutcome(
  outcome: FlowResult,
  selection: FlowCreateSelection,
  packageDirectory: string,
  submittedXml: string,
  scratch: string,
  runner: CoreRunner,
  query: FlowQuery,
  update?: FlowUpdateSelection
): Promise<void> {
  if (outcome.state !== 'succeeded') return;
  if (update) {
    const selectedFiles = flowFiles(outcome).filter(
      (file) => file.type === 'Flow' && file.fullName === selection.member
    );
    const expectedState = update.expectUnchanged === true ? 'Unchanged' : 'Changed';
    if (selectedFiles.length !== 1 || selectedFiles[0].state !== expectedState)
      throw new Error(
        update.expectUnchanged === true
          ? 'Repeated unchanged Flow UPDATE was not reported as Unchanged; reconcile before retrying'
          : 'Flow UPDATE was not reported as Changed; use --expect-unchanged only for an exact unchanged repeat'
      );
  }
  await verifyFlowReadback(selection, packageDirectory, submittedXml, runner, query, update);
  await assertNoPendingDeployments(query);
}

async function verifyFlowReadback(
  selection: FlowCreateSelection,
  packageDirectory: string,
  submittedXml: string,
  runner: CoreRunner,
  query: FlowQuery,
  update?: FlowUpdateSelection
): Promise<void> {
  const postWriteBaseline = update ? await assertPostWriteState(selection.member, update, query) : undefined;
  const retrievedXml = await retrieveFlowXml(selection, packageDirectory, runner, 'readback');
  const submitted: unknown = await parseStringPromise(submittedXml, { explicitArray: true, strict: true });
  const readback: unknown = await parseStringPromise(retrievedXml, { explicitArray: true, strict: true });
  if (!isDeepStrictEqual(readback, submitted))
    throw new Error('Independent Flow readback differs semantically from submitted source; reconcile before retrying');
  if (update) {
    if ((await assertPostWriteState(selection.member, update, query)) !== postWriteBaseline)
      throw new Error('Flow latest version changed during independent readback; reconcile before retrying');
    return;
  }
  const definitions = await query(
    `SELECT Id, LatestVersionId, ActiveVersionId FROM FlowDefinition WHERE DeveloperName = '${selection.member}'`,
    true
  );
  if (definitions.length !== 1 || definitions[0].ActiveVersionId !== null)
    throw new Error('Independent Flow readback found missing or active definition; reconcile before retrying');
}

async function assertPostWriteState(
  member: string,
  update: FlowUpdateSelection,
  query: FlowQuery
): Promise<string> {
  const definitions = await query(
    `SELECT Id, LatestVersionId, ActiveVersionId FROM FlowDefinition WHERE DeveloperName = '${member}'`,
    true
  );
  if (definitions.length !== 1 || definitions[0].ActiveVersionId !== null)
    throw new Error('Independent Flow readback found missing or active definition; reconcile before retrying');
  if (definitions[0].Id !== update.expectedDefinitionId)
    throw new Error('Independent Flow readback found a replaced definition; reconcile before retrying');
  const latestVersionId = definitions[0].LatestVersionId;
  if (typeof latestVersionId !== 'string' || !/^301[A-Za-z0-9]{15}$/.test(latestVersionId))
    throw new Error('Independent Flow readback found a missing latest version; reconcile before retrying');
  if (update.expectUnchanged === true && latestVersionId !== update.expectedLatestVersionId)
    throw new Error('Repeated unchanged Flow UPDATE unexpectedly replaced the latest version');
  const versions = await query(`SELECT Id, Status, LastModifiedDate FROM Flow WHERE Id = '${latestVersionId}'`, true);
  if (
    versions.length !== 1 ||
    versions[0].Id !== latestVersionId ||
    !['Draft', 'InvalidDraft'].includes(String(versions[0].Status)) ||
    typeof versions[0].LastModifiedDate !== 'string'
  )
    throw new Error('Independent Flow readback found an active or missing latest version');
  return JSON.stringify([
    definitions[0].Id,
    latestVersionId,
    definitions[0].ActiveVersionId,
    versions[0].Status,
    versions[0].LastModifiedDate,
  ]);
}

async function retrieveFlowXml(
  selection: FlowCreateSelection,
  packageDirectory: string,
  runner: CoreRunner,
  stage: 'baseline' | 'readback'
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `mcnext-flow-${stage}-`));
  try {
    await mkdir(join(root, packageDirectory), { recursive: true });
    await writeFile(
      join(root, 'sfdx-project.json'),
      JSON.stringify({ packageDirectories: [{ path: packageDirectory, default: true }] })
    );
    const retrieved = parseFlowResult(
      {
        projectRoot: root,
        targetOrg: selection.targetOrg,
        members: [selection.member],
        operation: 'retrieve',
        waitMinutes: selection.waitMinutes,
      },
      await runner(
        [
          'project',
          'retrieve',
          'start',
          '--target-org',
          selection.targetOrg,
          '--metadata',
          `Flow:${selection.member}`,
          '--wait',
          String(selection.waitMinutes ?? 10),
          '--json',
        ],
        root
      )
    );
    if (retrieved.state !== 'succeeded') throw new Error(`Independent Flow ${stage} retrieval did not complete`);
    try {
      return await readFile(
        join(root, packageDirectory, 'main', 'default', 'flows', `${selection.member}.flow-meta.xml`),
        'utf8'
      );
    } catch {
      throw new Error(`Independent Flow ${stage} retrieval did not materialize the expected source file`);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function assertUpdateSourceContract(
  baselineXml: string,
  submittedXml: string,
  expectUnchanged: boolean
): Promise<void> {
  let baseline: unknown;
  let submitted: unknown;
  try {
    baseline = await parseStringPromise(baselineXml, { explicitArray: true, strict: true });
    submitted = await parseStringPromise(submittedXml, { explicitArray: true, strict: true });
  } catch {
    throw new Error('Independent Flow baseline materialization is malformed');
  }
  if (expectUnchanged) {
    if (!isDeepStrictEqual(baseline, submitted))
      throw new Error('Repeated unchanged Flow UPDATE source differs from the independent pre-write baseline');
    return;
  }
  if (!isDeepStrictEqual(withoutFlowLabels(baseline), withoutFlowLabels(submitted)))
    throw new Error('Flow UPDATE contains changes outside the approved label/interview-label contract');
  if (isDeepStrictEqual(baseline, submitted))
    throw new Error(
      'Flow UPDATE requires a label or interview-label change; use --expect-unchanged for an exact repeat'
    );
}

function withoutFlowLabels(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const document = value as Record<string, unknown>;
  if (document.Flow === null || typeof document.Flow !== 'object' || Array.isArray(document.Flow)) return value;
  const flow = { ...(document.Flow as Record<string, unknown>) };
  delete flow.label;
  delete flow.interviewLabel;
  return { ...document, Flow: flow };
}

function flowFiles(result: FlowResult): Array<Record<string, unknown>> {
  return Array.isArray(result.coreResult.files)
    ? result.coreResult.files.filter(
        (file): file is Record<string, unknown> => file !== null && typeof file === 'object' && !Array.isArray(file)
      )
    : [];
}
