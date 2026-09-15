import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveCmsCliInvocation } from '../cms/cmsCli.js';

export type FlowOperation = 'retrieve' | 'validate' | 'create' | 'update';
export type FlowSelection = {
  projectRoot: string;
  targetOrg: string;
  members: string[];
  operation: FlowOperation;
  waitMinutes?: number;
};
export type CoreProcessResult = { stdout: string; exitCode: number };
export type CoreRunner = (args: string[], projectRoot: string) => Promise<CoreProcessResult>;
export type FlowResult = {
  operation: FlowOperation;
  members: string[];
  state: 'succeeded' | 'pending';
  jobId: string;
  coreExitCode: number;
  coreResult: Record<string, unknown>;
  diagnostics?: Array<Record<string, unknown>>;
  runtimeReadiness?: 'not-assessed';
};

/** Retain member-level Info as well as failure diagnostics, including on failed jobs. */
export class FlowJobError extends Error {
  public constructor(
    public readonly coreResult: Record<string, unknown>,
    public readonly diagnostics: Array<Record<string, unknown>>
  ) {
    super(
      `Core Flow job did not succeed (${String(coreResult.status)}); job ${String(
        coreResult.id
      )}; diagnostics: ${JSON.stringify(diagnostics)}`
    );
    this.name = 'FlowJobError';
  }
}

/** Select only named Flow members; Core owns source layout and XML transport. */
export function buildFlowArgs(selection: FlowSelection): string[] {
  if (!['retrieve', 'validate'].includes(selection.operation)) throw new Error('Unsupported Flow operation');
  if (!selection.targetOrg.trim() || selection.targetOrg.startsWith('-') || selection.targetOrg.includes('\0')) {
    throw new Error('An explicit target org is required');
  }
  if (!selection.members.length || selection.members.some((member) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(member))) {
    throw new Error('Select exact Flow API names; wildcards, paths and metadata type expressions are not supported');
  }
  if (new Set(selection.members).size !== selection.members.length) throw new Error('Duplicate Flow selection');
  const wait = selection.waitMinutes ?? 10;
  if (!Number.isSafeInteger(wait) || wait < 1 || wait > 30) throw new Error('Wait must be 1–30 minutes');
  return [
    'project',
    selection.operation === 'retrieve' ? 'retrieve' : 'deploy',
    'start',
    '--target-org',
    selection.targetOrg,
    ...selection.members.flatMap((member) => ['--metadata', `Flow:${member}`]),
    ...(selection.operation === 'validate' ? ['--dry-run'] : []),
    '--wait',
    String(wait),
    '--json',
  ];
}

/** Validate both the Salesforce JSON envelope and the asynchronous job state. */
export function parseFlowResult(selection: FlowSelection, processResult: CoreProcessResult): FlowResult {
  const envelope: unknown = JSON.parse(processResult.stdout);
  if (!isRecord(envelope) || envelope.status !== processResult.exitCode || !isRecord(envelope.result)) {
    throw new Error('Core Flow JSON envelope or exit status is invalid');
  }
  const result = envelope.result;
  const diagnostics = flowDiagnostics(result);
  if (['Failed', 'Canceled', 'SucceededPartial'].includes(String(result.status)))
    throw new FlowJobError(result, diagnostics);
  const pending = ['Pending', 'InProgress', 'Canceling', 'FinalizingDeploy'].includes(String(result.status));
  const expectedExit = selection.operation !== 'retrieve' && pending ? 69 : 0;
  if (processResult.exitCode !== expectedExit || typeof result.id !== 'string' || !result.id) {
    throw new Error('Core Flow command failed or returned no job identity');
  }
  if (pending && result.done === false) {
    return {
      operation: selection.operation,
      members: selection.members,
      state: 'pending',
      jobId: result.id,
      coreExitCode: processResult.exitCode,
      coreResult: result,
      diagnostics,
      runtimeReadiness: 'not-assessed',
    };
  }
  if (result.status !== 'Succeeded' || result.done !== true || result.success !== true) {
    throw new Error(`Core Flow job did not succeed (${String(result.status)})`);
  }
  assertCheckOnly(selection.operation, result);
  if (
    !Array.isArray(result.files) ||
    selection.members.some(
      (member) =>
        !(result.files as unknown[]).some(
          (file) =>
            isRecord(file) &&
            file.type === 'Flow' &&
            file.fullName === member &&
            file.state !== 'Failed' &&
            typeof file.filePath === 'string' &&
            file.filePath.length > 0
        )
    )
  ) {
    throw new Error('Core Flow result is missing selected source artifacts');
  }
  if (
    selection.operation === 'create' &&
    (result.checkOnly !== false ||
      (result.files as Array<Record<string, unknown>>).some((file) => file.type === 'Flow' && file.state !== 'Created'))
  ) {
    throw new Error('Core did not confirm a newly created Flow; inspect the job before retrying');
  }
  assertUpdateResult(selection, result);
  return {
    operation: selection.operation,
    members: selection.members,
    state: 'succeeded',
    jobId: result.id,
    coreExitCode: processResult.exitCode,
    coreResult: result,
    diagnostics,
    runtimeReadiness: 'not-assessed',
  };
}

/** Execute in an existing DX project without overriding its packageDirectories. No mutation is exposed. */
export async function runFlow(selection: FlowSelection, runner: CoreRunner = runCore): Promise<FlowResult> {
  const args = buildFlowArgs(selection);
  const projectRoot = resolve(selection.projectRoot);
  const project: unknown = JSON.parse(await readFile(join(projectRoot, 'sfdx-project.json'), 'utf8'));
  if (
    !isRecord(project) ||
    !Array.isArray(project.packageDirectories) ||
    !project.packageDirectories.length ||
    !project.packageDirectories.every(
      (entry: unknown) => isRecord(entry) && typeof entry.path === 'string' && entry.path.trim()
    )
  ) {
    throw new Error('A DX project with configured packageDirectories is required');
  }
  return parseFlowResult(selection, await runner(args, projectRoot));
}

export async function runCore(args: string[], projectRoot: string): Promise<CoreProcessResult> {
  const invocation = resolveCmsCliInvocation();
  const env = { ...process.env };
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'OCLIF_DEV', 'OCLIF_TS_NODE']) delete env[name];
  return new Promise((resolveResult, reject) => {
    execFile(
      invocation.executable,
      [...invocation.argsPrefix, ...args],
      {
        cwd: projectRoot,
        env,
        shell: false,
        windowsHide: true,
        timeout: 32 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error && (error.killed === true || typeof error.code !== 'number')) {
          reject(new Error('Core Flow subprocess failed or timed out; inspect Core job status before retrying'));
        } else {
          resolveResult({ stdout, exitCode: typeof error?.code === 'number' ? error.code : 0 });
        }
      }
    );
  });
}

function assertUpdateResult(selection: FlowSelection, result: Record<string, unknown>): void {
  if (
    selection.operation === 'update' &&
    (result.checkOnly !== false ||
      (result.files as Array<Record<string, unknown>>).some(
        (file) =>
          file.type !== 'Flow' ||
          !selection.members.includes(String(file.fullName)) ||
          !['Changed', 'Unchanged'].includes(String(file.state))
      ))
  ) {
    throw new Error('Core did not confirm an existing Flow UPDATE; inspect the job before retrying');
  }
}

function assertCheckOnly(operation: FlowOperation, result: Record<string, unknown>): void {
  if (operation === 'validate' && result.checkOnly !== true)
    throw new Error('Core did not confirm check-only validation');
}

function flowDiagnostics(result: Record<string, unknown>): Array<Record<string, unknown>> {
  const details = isRecord(result.details) ? result.details : {};
  const entries: unknown[] = [details.componentSuccesses, details.componentFailures, result.warnings].flatMap(
    (value): unknown[] => (Array.isArray(value) ? (value as unknown[]) : value ? [value] : [])
  );
  return entries.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && (typeof entry.problem === 'string' || typeof entry.message === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
