import { execFile } from 'node:child_process';
import { resolveCmsCliInvocation } from '../cms/cmsCli.js';

export type SegmentCoreProcessResult = { stdout: string; exitCode: number };
export type SegmentCoreRunner = (args: string[], projectRoot: string) => Promise<SegmentCoreProcessResult>;
export type SegmentCoreOperation = 'validate' | 'create' | 'retrieve';
export type SegmentCoreResult = {
  operation: SegmentCoreOperation;
  jobId: string;
  member: string;
  coreResult: Record<string, unknown>;
};

/** Execute one Core command without inheriting plugin-development process settings. */
export async function runSegmentCore(args: string[], projectRoot: string): Promise<SegmentCoreProcessResult> {
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
          reject(
            new Error('Core Segment Definition subprocess failed or timed out; inspect Core job state before retrying')
          );
        } else {
          resolveResult({ stdout, exitCode: typeof error?.code === 'number' ? error.code : 0 });
        }
      }
    );
  });
}

/** Require a terminal successful Core envelope for exactly one selected metadata member. */
export function parseSegmentCoreResult(
  operation: SegmentCoreOperation,
  member: string,
  processResult: SegmentCoreProcessResult
): SegmentCoreResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(processResult.stdout);
  } catch {
    throw new Error('Malformed Core Segment Definition JSON envelope');
  }
  if (!isRecord(envelope) || envelope.status !== processResult.exitCode || !isRecord(envelope.result))
    throw new Error('Invalid Core Segment Definition JSON envelope or exit status');
  const result = envelope.result;
  if (
    processResult.exitCode !== 0 ||
    result.status !== 'Succeeded' ||
    result.done !== true ||
    result.success !== true ||
    typeof result.id !== 'string' ||
    !result.id
  )
    throw new Error('Core Segment Definition job was not terminal successful; never retry or redeploy automatically');
  if (operation === 'validate' && result.checkOnly !== true)
    throw new Error('Core did not confirm check-only Segment Definition validation');
  if (operation === 'create' && result.checkOnly !== false)
    throw new Error('Core did not confirm Segment Definition apply');
  if (!Array.isArray(result.files)) throw new Error('Core Segment Definition result has no materialized member list');
  const selected = result.files.filter(
    (file): file is Record<string, unknown> =>
      isRecord(file) && file.type === 'MarketSegmentDefinition' && file.fullName === member
  );
  if (selected.length !== 1 || selected.some((file) => file.state === 'Failed'))
    throw new Error('Core Segment Definition result must contain exactly one selected member');
  if (operation === 'create' && selected[0].state !== 'Created')
    throw new Error(
      'Core did not confirm a newly created Segment Definition; no UPDATE or unchanged result is accepted'
    );
  return { operation, jobId: result.id, member, coreResult: result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
