import { execFile } from 'node:child_process';
import { lstat, open, readFile, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Messages, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import {
  associateFlow,
  FlowAssociationError,
  type FlowAssociationInput,
  type FlowAssociationResult,
} from '../../../core/flowAssociation.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.flow.association');
const execute = promisify(execFile);
export const flowAssociationServices = { associateFlow };
export type FlowAssociationCommandResult =
  | FlowAssociationResult
  | {
      operation: 'plan' | 'apply';
      state: 'failed';
      code: string;
      writeAttempted: boolean;
      writeOutcome: 'not-attempted' | 'unknown';
      associationResult?: FlowAssociationResult;
    };

/** Require caller correspondence and delegate every org operation to the reviewed service. */
export default class FlowAssociation extends SfCommand<FlowAssociationCommandResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly flags = {
    operation: Flags.option({
      summary: messages.getMessage('flags.operation.summary'),
      options: ['plan', 'apply'] as const,
      required: true,
    })(),
    'target-org': Flags.string({ summary: messages.getMessage('flags.target-org.summary'), required: true }),
    'expected-org-id': Flags.string({ summary: messages.getMessage('flags.expected-org-id.summary'), required: true }),
    'api-version': Flags.option({
      summary: messages.getMessage('flags.api-version.summary'),
      options: ['67.0'] as const,
      required: true,
    })(),
    'project-dir': Flags.directory({
      summary: messages.getMessage('flags.project-dir.summary'),
      required: true,
      exists: true,
    }),
    'input-file': Flags.string({ summary: messages.getMessage('flags.input-file.summary'), required: true }),
    'output-file': Flags.string({ summary: messages.getMessage('flags.output-file.summary') }),
  };

  public async run(): Promise<FlowAssociationCommandResult> {
    const { flags } = await this.parse(FlowAssociation);
    let output: FileHandle | undefined;
    let selection: Pick<FlowAssociationInput, 'artifact' | 'source' | 'target'>;
    try {
      const inputPath = await confinedFile(flags['project-dir'], flags['input-file']);
      if (!(await lstat(inputPath)).isFile()) throw new Error('Invalid file');
      const parsed: unknown = JSON.parse(await readFile(inputPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid input');
      const value = parsed as Record<string, unknown>;
      // Do not let JSON override flag identities or supply a transport/bypass option.
      if (Object.keys(value).some((key) => !['artifact', 'source', 'target'].includes(key)))
        throw new Error('Unexpected input field');
      selection = value as Pick<FlowAssociationInput, 'artifact' | 'source' | 'target'>;
      if (flags['output-file']) {
        const outputPath = await confinedFile(flags['project-dir'], flags['output-file']);
        // Reserve exclusive local output before the service can attempt a write; never clobber.
        output = await open(outputPath, 'wx', 0o600);
      }
    } catch {
      throw new SfError('Association input/output preflight failed; no org write attempted', 'INVALID_INPUT');
    }
    let result: FlowAssociationCommandResult;
    try {
      result = projectResult(
        await flowAssociationServices.associateFlow({
          ...selection,
          operation: flags.operation,
          targetOrg: flags['target-org'],
          expectedOrgId: flags['expected-org-id'],
          apiVersion: flags['api-version'],
        })
      );
    } catch (error) {
      // The service reconciles all post-attempt failures; never expose raw transport/auth details.
      result = {
        operation: flags.operation,
        state: 'failed',
        code: error instanceof FlowAssociationError ? error.code : 'BLOCKED',
        writeAttempted: error instanceof FlowAssociationError && error.writeAttempted,
        writeOutcome: error instanceof FlowAssociationError && error.writeAttempted ? 'unknown' : 'not-attempted',
      };
    }
    if (output) {
      try {
        await output.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
        await output.close();
      } catch {
        // A local publication failure does not erase an independently verified association result.
        await output.close().catch(() => undefined);
        result = {
          operation: flags.operation,
          state: 'failed',
          code: 'OUTPUT_WRITE_FAILED',
          writeAttempted: result.writeAttempted,
          writeOutcome: result.writeAttempted ? 'unknown' : 'not-attempted',
          ...(result.state === 'failed' ? {} : { associationResult: result }),
        };
      }
    }
    if (result.state === 'failed') process.exitCode = 1;
    this.log(`${result.operation}: ${result.state}; runtime readiness and business equivalence not assessed`);
    return result;
  }
}

function projectResult(result: FlowAssociationResult): FlowAssociationResult {
  return {
    operation: result.operation,
    state: result.state,
    orgId: result.orgId,
    campaignId: result.campaignId,
    flowRecordId: result.flowRecordId,
    segmentId: result.segmentId,
    definitionId: result.definitionId,
    latestVersionId: result.latestVersionId,
    writeAttempted: result.writeAttempted,
    writeOutcome: result.writeOutcome,
  };
}

/** Match existing Flow IO safeguards, including Windows reparse-point ancestor checks. */
async function confinedFile(projectRoot: string, file: string): Promise<string> {
  if (!file || /[\0\r\n*?]/u.test(file) || file.split(/[\\/]/u).includes('..')) throw new Error('Invalid path');
  const root = resolve(projectRoot);
  const target = resolve(root, file);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Outside project');
  if (process.platform === 'win32') {
    await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; $p=$env:SF_MCNEXT_FLOW_PATH; while ($p) { if (Test-Path -LiteralPath $p) { $i=Get-Item -LiteralPath $p -Force; if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Flow path reparse point rejected' } }; $next=[IO.Path]::GetDirectoryName($p); if ($next -eq $p) { break }; $p=$next }",
      ],
      { env: { ...process.env, SF_MCNEXT_FLOW_PATH: target }, windowsHide: true }
    );
  }
  let current = target;
  while (current) {
    try {
      // eslint-disable-next-line no-await-in-loop -- validate every ancestor before command IO
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) throw new Error('Unsafe path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}
