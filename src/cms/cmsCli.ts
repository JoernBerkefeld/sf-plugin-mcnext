import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import {
  validateCmsExport,
  validateCmsInfo,
  validateCmsStatusExit,
  type CmsEnvelope,
  type CmsExportResult,
  type CmsInfoResult,
} from './contracts.js';

export const CMS_INFO_ARGS = ['cms', 'info', '--contract-version', '1', '--json'] as const;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_LIMIT = 1_048_576;
const REMOVED_ENVIRONMENT_VARIABLES = ['NODE_OPTIONS', 'NODE_PATH', 'OCLIF_DEV', 'OCLIF_TS_NODE'] as const;

type CmsCliOperation = 'info' | 'export';
type ProcessSpawner = typeof spawn;

type CmsCliInvocation = {
  executable: string;
  argsPrefix: string[];
};

export type CmsCliOptions = {
  executable?: string;
  cliEntrypoint?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  outputLimitBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  spawn?: ProcessSpawner;
};

export class CmsCliError extends Error {}

/** Build the exact allowlisted aggregate Marketing workspace export arguments. */
export function buildCmsExportArgs(sourceOrg: string, outputDirectory: string): string[] {
  requireInput(sourceOrg, 'source org');
  requireInput(outputDirectory, 'output directory');
  return [
    'cms',
    'export',
    'workspace',
    '--target-org',
    sourceOrg,
    '--all',
    '--workspace-type',
    'Marketing',
    '--output-dir',
    outputDirectory,
    '--contract-version',
    '1',
    '--json',
  ];
}

/** Run the allowlisted read-only CMS discovery command. */
export async function runCmsInfo(options: CmsCliOptions = {}): Promise<ReturnType<typeof validateCmsInfo>> {
  const processResult = await runAllowlistedCmsCommand('info', CMS_INFO_ARGS, options);
  try {
    validateCmsStatusExit(processResult.value.status, processResult.exitCode);
    return validateCmsInfo(processResult.value);
  } catch (error) {
    throw cliError('validation failed', error);
  }
}

/** Run the allowlisted read-only aggregate CMS export command. */
export async function runCmsExport(
  sourceOrg: string,
  outputDirectory: string,
  options: CmsCliOptions = {}
): Promise<CmsEnvelope<CmsExportResult>> {
  const processResult = await runAllowlistedCmsCommand(
    'export',
    buildCmsExportArgs(sourceOrg, outputDirectory),
    options
  );
  try {
    const envelope = validateCmsExport(processResult.value);
    validateCmsStatusExit(envelope.status, processResult.exitCode);
    return envelope;
  } catch (error) {
    throw cliError('validation failed', error);
  }
}

async function runAllowlistedCmsCommand(
  operation: CmsCliOperation,
  args: readonly string[],
  options: CmsCliOptions
): Promise<{ value: CmsEnvelope<CmsInfoResult | CmsExportResult>; exitCode: number }> {
  assertCmsCliInvocation(operation, args);
  const invocation = resolveCmsCliInvocation(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new CmsCliError('CMS CLI timeout must be a positive integer');
  if (!Number.isSafeInteger(outputLimit) || outputLimit <= 0)
    throw new CmsCliError('CMS CLI output limit must be a positive integer');

  const spawnOptions: SpawnOptionsWithoutStdio = {
    shell: false,
    windowsHide: true,
    env: safeEnvironment(options.env ?? process.env),
  };
  let child: ReturnType<ProcessSpawner>;
  try {
    child = (options.spawn ?? spawn)(invocation.executable, [...invocation.argsPrefix, ...args], spawnOptions);
  } catch (error) {
    throw cliError('spawn failed', error);
  }

  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let outputExceeded = false;
  const append = (current: string, chunk: Buffer | string): string => {
    const text = chunk.toString();
    outputBytes += Buffer.byteLength(text);
    if (outputBytes > outputLimit) {
      outputExceeded = true;
      child.kill();
      return current;
    }
    return current + text;
  };
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout = append(stdout, chunk);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = append(stderr, chunk);
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const abort = (): void => {
    child.kill();
  };
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
      child.once('error', (error) => reject(cliError('spawn failed', error, stderr)));
    });
    if (outputExceeded) throw new CmsCliError(`CMS CLI output exceeded limit; stderr=${redact(stderr)}`);
    if (timedOut) throw new CmsCliError(`CMS CLI timed out; stderr=${redact(stderr)}`);
    if (options.signal?.aborted) throw new CmsCliError(`CMS CLI aborted; stderr=${redact(stderr)}`);
    if (outcome.signal !== null)
      throw new CmsCliError(`CMS CLI terminated by signal ${outcome.signal}; stderr=${redact(stderr)}`);
    if (outcome.code === null) throw new CmsCliError(`CMS CLI returned no exit code; stderr=${redact(stderr)}`);
    return { value: parseExactlyOneJson(stdout, stderr), exitCode: outcome.code };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/** Resolve a shell-free Salesforce CLI invocation for the current platform. */
export function resolveCmsCliInvocation(options: CmsCliOptions = {}): CmsCliInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { executable: options.executable ?? 'sf', argsPrefix: [] };

  const env = options.env ?? process.env;
  const override = options.cliEntrypoint ?? env.SF_CLI_ENTRYPOINT;
  if (options.executable !== undefined && override === undefined) {
    throw new CmsCliError('CMS CLI Windows executable override requires a validated CLI entrypoint');
  }
  if (override !== undefined) {
    return { executable: options.executable ?? process.execPath, argsPrefix: [validateCliEntrypoint(override)] };
  }

  const hostEntrypoint = findHostCliEntrypoint(options.argv ?? process.argv);
  if (hostEntrypoint !== undefined) {
    return { executable: options.executable ?? process.execPath, argsPrefix: [hostEntrypoint] };
  }

  const entrypoint = findWindowsCliEntrypoint(env);
  if (entrypoint === undefined) {
    throw new CmsCliError('CMS CLI could not resolve a safe Salesforce CLI Node entrypoint on Windows');
  }

  return { executable: options.executable ?? process.execPath, argsPrefix: [entrypoint] };
}

export function assertCmsCliInvocation(operation: CmsCliOperation, args: readonly string[]): void {
  const expected = operation === 'info' ? CMS_INFO_ARGS : buildCmsExportArgs(args[4] ?? '', args[9] ?? '');
  if (args.length !== expected.length || args.some((arg, index) => arg !== expected[index])) {
    throw new CmsCliError('CMS CLI operation or arguments are not allowlisted');
  }
  if (args.includes('import') || args.includes('--apply')) throw new CmsCliError('CMS CLI mutation is prohibited');
}

function parseExactlyOneJson(stdout: string, stderr: string): CmsEnvelope<CmsInfoResult | CmsExportResult> {
  const framed = stdout.trim();
  if (framed.length === 0) throw new CmsCliError(`CMS CLI returned no JSON; stderr=${redact(stderr)}`);
  try {
    return JSON.parse(framed) as CmsEnvelope<CmsInfoResult | CmsExportResult>;
  } catch (error) {
    throw cliError('returned malformed or multiple JSON values', error, `${stdout}\n${stderr}`);
  }
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...source };
  for (const name of REMOVED_ENVIRONMENT_VARIABLES) delete result[name];
  return result;
}

function findHostCliEntrypoint(argv: readonly string[]): string | undefined {
  const value = argv[1];
  if (value === undefined || !looksLikeCliEntrypoint(value)) return undefined;
  try {
    return validateCliEntrypoint(value);
  } catch {
    return undefined;
  }
}

function findWindowsCliEntrypoint(env: NodeJS.ProcessEnv): string | undefined {
  const candidates = new Set<string>();
  const addNpmRoot = (root: string | undefined): void => {
    if (root) candidates.add(join(root, '@salesforce', 'cli', 'bin', 'run.js'));
  };
  const npmPrefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  addNpmRoot(npmPrefix === undefined ? undefined : join(npmPrefix, 'node_modules'));
  addNpmRoot(env.APPDATA === undefined ? undefined : join(env.APPDATA, 'npm', 'node_modules'));
  addNpmRoot(env.ProgramFiles === undefined ? undefined : join(env.ProgramFiles, 'nodejs', 'node_modules'));
  addNpmRoot(join(process.cwd(), 'node_modules'));
  addNpmRoot(join(dirname(process.execPath), 'node_modules'));
  for (const pathEntry of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (pathEntry) addNpmRoot(join(resolvePath(pathEntry), 'node_modules'));
  }

  const validEntrypoints = new Set<string>();
  for (const candidate of candidates) {
    try {
      validEntrypoints.add(validateCliEntrypoint(candidate));
    } catch {
      // Continue through bounded, derived candidates only.
    }
  }
  if (validEntrypoints.size > 1) {
    throw new CmsCliError(`CMS CLI fallback discovery is ambiguous (${validEntrypoints.size} valid entrypoints)`);
  }
  return validEntrypoints.values().next().value;
}

function looksLikeCliEntrypoint(value: string): boolean {
  return value.toLowerCase().replaceAll('\\', '/').endsWith('/@salesforce/cli/bin/run.js');
}

function validateCliEntrypoint(value: string): string {
  if (value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new CmsCliError('CMS CLI entrypoint override must be a non-empty absolute path');
  }
  const entrypoint = resolvePath(value);
  if (!entrypoint.toLowerCase().endsWith(join('@salesforce', 'cli', 'bin', 'run.js').toLowerCase())) {
    throw new CmsCliError('CMS CLI entrypoint must target @salesforce/cli/bin/run.js');
  }
  if (!existsSync(entrypoint) || !statSync(entrypoint).isFile()) {
    throw new CmsCliError('CMS CLI entrypoint does not exist or is not a file');
  }
  const packageJson = join(dirname(dirname(entrypoint)), 'package.json');
  try {
    const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: unknown; bin?: unknown };
    if (manifest.name !== '@salesforce/cli' || !isSalesforceCliBin(manifest.bin)) throw new Error('invalid manifest');
  } catch {
    throw new CmsCliError('CMS CLI entrypoint package validation failed');
  }
  return entrypoint;
}

function isSalesforceCliBin(bin: unknown): boolean {
  if (typeof bin === 'string') return bin.replaceAll('\\', '/') === './bin/run.js';
  if (bin === null || typeof bin !== 'object') return false;
  const sf = (bin as Record<string, unknown>).sf;
  return typeof sf === 'string' && sf.replaceAll('\\', '/') === './bin/run.js';
}

function requireInput(value: string, label: string): void {
  if (value.length === 0 || value.includes('\0')) throw new CmsCliError(`CMS CLI ${label} is required`);
}

function cliError(message: string, error: unknown, diagnostics = ''): CmsCliError {
  const detail = error instanceof Error ? error.message : String(error);
  return new CmsCliError(`CMS CLI ${message}: ${redact(`${detail} ${diagnostics}`)}`);
}

/** Bound provider text before displaying or persisting diagnostic evidence. */
export function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization|token|secret|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[A-Za-z]:[\\/][^\r\n"']+/g, '[REDACTED_PATH]')
    .replace(/\\\\[^\r\n"']+/g, '[REDACTED_PATH]')
    .replace(/(^|[\s("'=])\/[^\s"']+/g, '$1[REDACTED_PATH]')
    .slice(0, 2048);
}
