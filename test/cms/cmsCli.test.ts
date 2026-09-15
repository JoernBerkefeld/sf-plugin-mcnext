import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { expect } from 'chai';
import {
  assertCmsCliInvocation,
  buildCmsExportArgs,
  CMS_INFO_ARGS,
  CmsCliError,
  resolveCmsCliInvocation,
  runCmsExport,
  runCmsInfo,
} from '../../src/cms/cmsCli.js';
import { cloneFixture, validExportFixture, validInfoFixture } from './contractFixtures.js';

type SpawnCall = { executable: string; args: string[]; options: Parameters<typeof spawn>[2] };

type MockOutcome = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  error?: Error;
  delayMs?: number;
};

function mockSpawner(outcome: MockOutcome, calls: SpawnCall[]): typeof spawn {
  return ((executable: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter() as ChildProcess;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (() => {
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      return true;
    }) as ChildProcess['kill'];
    setTimeout(() => {
      if (outcome.error) {
        child.emit('error', outcome.error);
        setTimeout(() => child.emit('close', null, null), 0);
        return;
      }
      const stdout = child.stdout as PassThrough;
      const stderr = child.stderr as PassThrough;
      stdout.write(outcome.stdout ?? '');
      stderr.write(outcome.stderr ?? '');
      stdout.end();
      stderr.end();
      child.emit('close', outcome.exitCode ?? 0, outcome.signal ?? null);
    }, outcome.delayMs ?? 0);
    return child;
  }) as typeof spawn;
}

function createCliEntrypoint(npmRoot?: string): string {
  const root = npmRoot ?? join(mkdtempSync(join(tmpdir(), 'sf-cli-')), 'node_modules');
  const packageRoot = join(root, '@salesforce', 'cli');
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@salesforce/cli', bin: { sf: './bin/run.js' } })
  );
  const entrypoint = join(packageRoot, 'bin', 'run.js');
  writeFileSync(entrypoint, '');
  return entrypoint;
}

async function rejects(promise: Promise<unknown>, detail: string): Promise<void> {
  try {
    await promise;
    expect.fail('expected rejection');
  } catch (error) {
    expect(error).to.be.instanceOf(CmsCliError);
    expect((error as Error).message).to.include(detail);
  }
}

describe('CMS read-only CLI boundary', () => {
  it('uses exact info argv, shell false, and a minimally sanitized inherited environment', async () => {
    const calls: SpawnCall[] = [];
    const env = {
      PATH: 'sf-path',
      SF_TARGET_ORG: 'auth-alias',
      NODE_OPTIONS: '--require attacker',
      NODE_PATH: 'attacker',
    };
    await runCmsInfo({
      platform: 'linux',
      spawn: mockSpawner({ stdout: JSON.stringify(validInfoFixture) }, calls),
      env,
    });
    expect(calls).to.have.length(1);
    expect(calls[0].executable).to.equal('sf');
    expect(calls[0].args).to.deep.equal([...CMS_INFO_ARGS]);
    expect(calls[0].options).to.include({ shell: false, windowsHide: true });
    expect(calls[0].options?.env).to.include({ PATH: 'sf-path', SF_TARGET_ORG: 'auth-alias' });
    expect(calls[0].options?.env).not.to.have.keys('NODE_OPTIONS', 'NODE_PATH');
  });

  it('resolves Windows to Node plus the validated Salesforce CLI entrypoint without changing real argv', async () => {
    const calls: SpawnCall[] = [];
    const cliEntrypoint = createCliEntrypoint();
    const realArgs = [...CMS_INFO_ARGS];
    await runCmsInfo({
      platform: 'win32',
      argv: [process.execPath, cliEntrypoint, ...realArgs],
      spawn: mockSpawner({ stdout: JSON.stringify(validInfoFixture) }, calls),
      env: {},
    });
    expect(calls[0].executable).to.equal(process.execPath);
    expect(calls[0].args).to.deep.equal([cliEntrypoint, ...realArgs]);
    expect(realArgs).to.deep.equal([...CMS_INFO_ARGS]);
    expect(calls[0].options).to.include({ shell: false });
  });

  it('gives the explicit option override precedence over environment, host, and fallback entrypoints', () => {
    const optionEntrypoint = createCliEntrypoint();
    const environmentEntrypoint = createCliEntrypoint();
    const hostEntrypoint = createCliEntrypoint();
    const fallbackRoot = mkdtempSync(join(tmpdir(), 'sf-prefix-'));
    createCliEntrypoint(join(fallbackRoot, 'node_modules'));
    expect(
      resolveCmsCliInvocation({
        platform: 'win32',
        cliEntrypoint: optionEntrypoint,
        argv: [process.execPath, hostEntrypoint, 'cms', 'info'],
        env: { SF_CLI_ENTRYPOINT: environmentEntrypoint, NPM_CONFIG_PREFIX: fallbackRoot },
      })
    ).to.deep.equal({ executable: process.execPath, argsPrefix: [optionEntrypoint] });
  });

  it('uses a validated environment override before the host entrypoint and with an executable override', () => {
    const environmentEntrypoint = createCliEntrypoint();
    const hostEntrypoint = createCliEntrypoint();
    expect(
      resolveCmsCliInvocation({
        platform: 'win32',
        executable: 'test-node.exe',
        argv: [process.execPath, hostEntrypoint],
        env: { SF_CLI_ENTRYPOINT: environmentEntrypoint },
      })
    ).to.deep.equal({ executable: 'test-node.exe', argsPrefix: [environmentEntrypoint] });
  });

  it('uses the current validated host CLI before other valid discovered installations', () => {
    const hostEntrypoint = createCliEntrypoint();
    const fallbackRoot = mkdtempSync(join(tmpdir(), 'sf-prefix-'));
    createCliEntrypoint(join(fallbackRoot, 'node_modules'));
    expect(
      resolveCmsCliInvocation({
        platform: 'win32',
        argv: [process.execPath, hostEntrypoint, 'cms', 'info', '--json'],
        env: { NPM_CONFIG_PREFIX: fallbackRoot },
      })
    ).to.deep.equal({ executable: process.execPath, argsPrefix: [hostEntrypoint] });
  });

  it('uses one unique validated fallback entrypoint', () => {
    const fallbackRoot = mkdtempSync(join(tmpdir(), 'sf-prefix-'));
    const cliEntrypoint = createCliEntrypoint(join(fallbackRoot, 'node_modules'));
    expect(
      resolveCmsCliInvocation({ platform: 'win32', argv: [], env: { NPM_CONFIG_PREFIX: fallbackRoot } })
    ).to.deep.equal({
      executable: process.execPath,
      argsPrefix: [cliEntrypoint],
    });
  });

  it('rejects ambiguous fallback discovery instead of selecting the first installation', () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'sf-prefix-a-'));
    const secondAppData = mkdtempSync(join(tmpdir(), 'sf-appdata-b-'));
    createCliEntrypoint(join(firstRoot, 'node_modules'));
    createCliEntrypoint(join(secondAppData, 'npm', 'node_modules'));
    expect(() =>
      resolveCmsCliInvocation({
        platform: 'win32',
        argv: [],
        env: { NPM_CONFIG_PREFIX: firstRoot, APPDATA: secondAppData },
      })
    ).to.throw(CmsCliError, 'fallback discovery is ambiguous (2 valid entrypoints)');
  });

  it('ignores an invalid argv[1] host entrypoint and uses a unique fallback', () => {
    const fallbackRoot = mkdtempSync(join(tmpdir(), 'sf-prefix-'));
    const fallbackEntrypoint = createCliEntrypoint(join(fallbackRoot, 'node_modules'));
    const invalidHost = join(
      mkdtempSync(join(tmpdir(), 'sf-invalid-host-')),
      'node_modules',
      '@salesforce',
      'cli',
      'bin',
      'run.js'
    );
    expect(
      resolveCmsCliInvocation({
        platform: 'win32',
        argv: [process.execPath, invalidHost, 'cms', 'info'],
        env: { NPM_CONFIG_PREFIX: fallbackRoot },
      })
    ).to.deep.equal({ executable: process.execPath, argsPrefix: [fallbackEntrypoint] });
  });

  it('validates Windows overrides and fails closed when no safe entrypoint exists', () => {
    expect(() => resolveCmsCliInvocation({ platform: 'win32', cliEntrypoint: 'relative\\run.js', env: {} })).to.throw(
      CmsCliError,
      'absolute path'
    );
    expect(() =>
      resolveCmsCliInvocation({ platform: 'win32', cliEntrypoint: join(tmpdir(), 'run.js'), env: {} })
    ).to.throw(CmsCliError, '@salesforce/cli/bin/run.js');
    expect(() => resolveCmsCliInvocation({ platform: 'win32', env: { PATH: '' } })).to.throw(
      CmsCliError,
      'could not resolve a safe Salesforce CLI Node entrypoint'
    );
  });

  it('preserves unchanged POSIX sf behavior', () => {
    expect(resolveCmsCliInvocation({ platform: 'linux', env: {} })).to.deep.equal({ executable: 'sf', argsPrefix: [] });
  });

  it('uses exact aggregate Marketing export argv and validates success and partial exits', async () => {
    expect(buildCmsExportArgs('source', 'run/export')).to.deep.equal([
      'cms',
      'export',
      'workspace',
      '--target-org',
      'source',
      '--all',
      '--workspace-type',
      'Marketing',
      '--output-dir',
      'run/export',
      '--contract-version',
      '1',
      '--json',
    ]);
    const calls: SpawnCall[] = [];
    await runCmsExport('source', 'run/export', {
      spawn: mockSpawner({ stdout: JSON.stringify(validExportFixture), exitCode: 0 }, calls),
    });
    const partial = cloneFixture(validExportFixture);
    partial.status = 'partial';
    partial.result!.workspaces[0].status = 'partial';
    partial.result!.summary = { succeededCount: 0, partialCount: 1, failedCount: 0 };
    await runCmsExport('source', 'run/export', {
      spawn: mockSpawner({ stdout: JSON.stringify(partial), exitCode: 2 }, calls),
    });
    expect(calls).to.have.length(2);
  });

  it('blocks status/exit disagreements', async () => {
    await rejects(
      runCmsInfo({ spawn: mockSpawner({ stdout: JSON.stringify(validInfoFixture), exitCode: 1 }, []) }),
      'status success requires exit 0'
    );
  });

  it('rejects a Salesforce outer JSON envelope without unwrapping its valid CMS result', async () => {
    const calls: SpawnCall[] = [];
    const salesforceEnvelope = { status: 2, result: validExportFixture, warnings: [] };
    await rejects(
      runCmsExport('source', 'run/export', {
        platform: 'linux',
        spawn: mockSpawner({ stdout: JSON.stringify(salesforceEnvelope), exitCode: 2 }, calls),
      }),
      'envelope fields'
    );
    expect(calls).to.have.length(1);
    expect(calls[0].args).to.deep.equal(buildCmsExportArgs('source', 'run/export'));
  });

  it('rejects malformed, multiple, empty, and oversized stdout', async () => {
    await rejects(runCmsInfo({ spawn: mockSpawner({ stdout: '{bad' }, []) }), 'malformed or multiple JSON');
    const json = JSON.stringify(validInfoFixture);
    await rejects(runCmsInfo({ spawn: mockSpawner({ stdout: `${json}\n${json}` }, []) }), 'malformed or multiple JSON');
    await rejects(runCmsInfo({ spawn: mockSpawner({ stdout: '' }, []) }), 'no JSON');
    await rejects(
      runCmsInfo({ spawn: mockSpawner({ stdout: json }, []), outputLimitBytes: 10 }),
      'output exceeded limit'
    );
  });

  it('handles timeout, abort, signal termination, and spawn failure', async () => {
    await rejects(runCmsInfo({ spawn: mockSpawner({ delayMs: 50 }, []), timeoutMs: 5 }), 'timed out');
    const controller = new AbortController();
    const aborted = runCmsInfo({ spawn: mockSpawner({ delayMs: 50 }, []), signal: controller.signal });
    controller.abort();
    await rejects(aborted, 'aborted');
    await rejects(runCmsInfo({ spawn: mockSpawner({ signal: 'SIGTERM' }, []) }), 'terminated by signal SIGTERM');
    await rejects(runCmsInfo({ spawn: mockSpawner({ error: new Error('ENOENT') }, []) }), 'spawn failed');
  });

  it('redacts secrets and absolute paths from safe diagnostics', async () => {
    try {
      await runCmsInfo({
        spawn: mockSpawner(
          { stdout: '{bad', stderr: 'authorization=Bearer-secret C:\\Users\\person\\private\\file\ntoken=abc' },
          []
        ),
      });
      expect.fail('expected rejection');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).to.include('authorization=[REDACTED]');
      expect(message).to.include('[REDACTED_PATH]');
      expect(message).to.include('token=[REDACTED]');
      expect(message)
        .not.to.include('Bearer-secret')
        .and.not.to.include('person\\private')
        .and.not.to.include('token=abc');
    }
  });

  it('proves import, apply, arbitrary commands, and missing required inputs cannot execute', () => {
    expect(() => assertCmsCliInvocation('info', ['cms', 'import', 'workspace', '--apply'])).to.throw(CmsCliError);
    expect(() => assertCmsCliInvocation('export', ['cms', 'delete', 'workspace'])).to.throw(CmsCliError);
    expect(() => assertCmsCliInvocation('export', [...buildCmsExportArgs('source', 'out'), '--apply'])).to.throw(
      CmsCliError
    );
    expect(() => buildCmsExportArgs('', 'out')).to.throw(CmsCliError, 'source org is required');
    expect(() => buildCmsExportArgs('source', '')).to.throw(CmsCliError, 'output directory is required');
  });
});
