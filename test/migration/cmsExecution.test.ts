import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import type { Org } from '@salesforce/core';
import { expect } from 'chai';
import type { CmsEnvelope, CmsImportResult } from '../../src/cms/contracts.js';
import { buildCmsExecutionPlan, executeCmsPlan } from '../../src/migration/cmsExecution.js';
import { validInfoFixture } from '../cms/contractFixtures.js';

const sourceWorkspaceId = '0Zu000000000001AAA';
const targetWorkspaceId = '0Zu000000000002AAA';
const targetOrgId = '00D000000000001AAA';
const manifestSha256 = createHash('sha256').update('{}\n').digest('hex');

type SpawnCall = { args: string[] };

function importFixture(status: 'success' | 'partial' | 'failed' = 'success'): CmsEnvelope<CmsImportResult> {
  return {
    contract: 'sf-cms-workspace-import',
    contractVersion: '1.0.0',
    status,
    metadata: {
      operation: 'workspace.import',
      plugin: { name: 'sf-plugin-cms', version: '9.8.7' },
      apiVersion: '67.0',
    },
    diagnostics: { warnings: [], errors: [] },
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: 'offline',
      pluginVersion: '9.8.7',
      command: 'sf cms import workspace',
      generatedAt: '2026-09-27T00:00:00.000Z',
    },
    result: {
      sourcePackage: { manifestSha256, workspaceId: sourceWorkspaceId },
      target: { orgId: targetOrgId, workspaceId: targetWorkspaceId },
      integrity: { listedItemCount: 0, verifiedItemCount: 0, unlistedFileCount: 0, verified: true },
      mappings: [],
      references: [],
    },
  };
}

function queuedSpawner(values: Array<{ envelope: unknown; exitCode?: number }>, calls: SpawnCall[]): typeof spawn {
  return ((_executable: string, args: string[]) => {
    calls.push({ args });
    const child = new EventEmitter() as ChildProcess;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (() => true) as ChildProcess['kill'];
    const next = values.shift();
    if (!next) throw new Error('unexpected CMS CLI invocation');
    queueMicrotask(() => {
      (child.stdout as PassThrough).end(JSON.stringify(next.envelope));
      (child.stderr as PassThrough).end();
      child.emit('close', next.exitCode ?? 0, null);
    });
    return child;
  }) as typeof spawn;
}

function fakeOrg(orgId = targetOrgId): Org {
  return { getOrgId: () => orgId } as Org;
}

async function rejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
    expect.fail('expected rejection');
  } catch (error) {
    expect((error as Error).message).to.include(message);
  }
}

describe('CMS migration execution', () => {
  let directory: string;
  let sourceDirectory: string;
  let sourcePlanFile: string;
  let sourcePlanSha256: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcnext-cms-execution-'));
    sourceDirectory = join(directory, sourceWorkspaceId);
    sourcePlanFile = join(directory, 'migration-plan.json');
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, 'manifest.json'), '{}\n');
    await writeFile(sourcePlanFile, '{"schemaVersion":1}\n');
    sourcePlanSha256 = createHash('sha256').update(await readFile(sourcePlanFile)).digest('hex');
  });

  afterEach(async () => rm(directory, { recursive: true, force: true }));

  it('builds an immutable canonical plan and completes dry-run without apply', async () => {
    const calls: SpawnCall[] = [];
    const cli = {
      platform: 'linux' as const,
      spawn: queuedSpawner(
        [{ envelope: validInfoFixture }, { envelope: validInfoFixture }, { envelope: importFixture() }],
        calls
      ),
    };
    const plan = await buildCmsExecutionPlan({
      sourcePlanFile,
      sourcePlanSha256,
      targetOrg: 'target',
      targetOrgId,
      workspaceMapSha256: 'b'.repeat(64),
      routes: [{ sourceWorkspaceId, targetWorkspaceId, sourceDirectory, packageManifestSha256: manifestSha256 }],
      reportRoot: join(directory, 'reports'),
      cli,
    });
    const result = await executeCmsPlan({ plan, targetOrg: fakeOrg(), apply: false, allowExperimental: true, cli });

    expect(result).to.include({ mode: 'dry-run', status: 'success' });
    expect(result.completedRoutes.map((route) => route.sourceWorkspaceId)).to.deep.equal([sourceWorkspaceId]);
    expect(calls.filter((call) => call.args.includes('--apply'))).to.have.length(0);
    expect(calls).to.have.length(3);
  });

  it('preflights before apply, applies once, and stops on provider partial exit 2', async () => {
    const calls: SpawnCall[] = [];
    const cli = {
      platform: 'linux' as const,
      spawn: queuedSpawner(
        [
          { envelope: validInfoFixture },
          { envelope: validInfoFixture },
          { envelope: importFixture() },
          { envelope: validInfoFixture },
          { envelope: importFixture() },
          { envelope: validInfoFixture },
          { envelope: importFixture('partial'), exitCode: 2 },
        ],
        calls
      ),
    };
    const plan = await buildCmsExecutionPlan({
      sourcePlanFile,
      sourcePlanSha256,
      targetOrg: 'target',
      targetOrgId,
      workspaceMapSha256: 'b'.repeat(64),
      routes: [{ sourceWorkspaceId, targetWorkspaceId, sourceDirectory, packageManifestSha256: manifestSha256 }],
      reportRoot: join(directory, 'reports'),
      cli,
    });
    const result = await executeCmsPlan({ plan, targetOrg: fakeOrg(), apply: true, allowExperimental: true, cli });

    expect(result).to.include({ mode: 'apply', status: 'partial', stoppedAt: sourceWorkspaceId });
    expect(calls.filter((call) => call.args.includes('--apply'))).to.have.length(1);
    expect(calls).to.have.length(7);
  });

  it('blocks non-create preflight mappings before apply', async () => {
    const calls: SpawnCall[] = [];
    const unsafePreflight = importFixture();
    unsafePreflight.result!.mappings.push({
      referenceId: 'ref-1',
      kind: 'cms.content',
      source: { sourceId: 'source-1', portableKey: { scheme: 'cms-opaque-v1', value: 'opaque' } },
      target: { targetId: 'target-1', targetReference: 'target-ref-1' },
      operation: 'updated',
      status: 'resolved',
      cmsReferencesRewritten: true,
    });
    const cli = {
      platform: 'linux' as const,
      spawn: queuedSpawner(
        [
          { envelope: validInfoFixture },
          { envelope: validInfoFixture },
          { envelope: importFixture() },
          { envelope: validInfoFixture },
          { envelope: unsafePreflight },
        ],
        calls
      ),
    };
    const plan = await buildCmsExecutionPlan({
      sourcePlanFile,
      sourcePlanSha256,
      targetOrg: 'target',
      targetOrgId,
      workspaceMapSha256: 'b'.repeat(64),
      routes: [{ sourceWorkspaceId, targetWorkspaceId, sourceDirectory, packageManifestSha256: manifestSha256 }],
      reportRoot: join(directory, 'reports'),
      cli,
    });

    await rejects(
      () => executeCmsPlan({ plan, targetOrg: fakeOrg(), apply: true, allowExperimental: true, cli }),
      'not safe for create-only apply'
    );
    expect(calls.filter((call) => call.args.includes('--apply'))).to.have.length(0);
  });

  it('rejects mismatched provider route bindings', async () => {
    const calls: SpawnCall[] = [];
    const mismatched = importFixture();
    mismatched.result!.target.workspaceId = '0Zu000000000009AAA';
    const cli = {
      platform: 'linux' as const,
      spawn: queuedSpawner(
        [{ envelope: validInfoFixture }, { envelope: validInfoFixture }, { envelope: mismatched }],
        calls
      ),
    };
    const plan = await buildCmsExecutionPlan({
      sourcePlanFile,
      sourcePlanSha256,
      targetOrg: 'target',
      targetOrgId,
      workspaceMapSha256: 'b'.repeat(64),
      routes: [{ sourceWorkspaceId, targetWorkspaceId, sourceDirectory, packageManifestSha256: manifestSha256 }],
      reportRoot: join(directory, 'reports'),
      cli,
    });

    await rejects(
      () => executeCmsPlan({ plan, targetOrg: fakeOrg(), apply: false, allowExperimental: true, cli }),
      'CMS import result binding changed'
    );
  });

  it('rejects a changed planned manifest before provider discovery', async () => {
    const calls: SpawnCall[] = [];
    const cli = {
      platform: 'linux' as const,
      spawn: queuedSpawner([{ envelope: validInfoFixture }], calls),
    };
    await writeFile(join(sourceDirectory, 'manifest.json'), '{"changed":true}\n');

    await rejects(
      () =>
        buildCmsExecutionPlan({
          sourcePlanFile,
          sourcePlanSha256,
          targetOrg: 'target',
          targetOrgId,
          workspaceMapSha256: 'b'.repeat(64),
          routes: [{ sourceWorkspaceId, targetWorkspaceId, sourceDirectory, packageManifestSha256: manifestSha256 }],
          reportRoot: join(directory, 'reports'),
          cli,
        }),
      'CMS manifest binding changed'
    );
    expect(calls).to.have.length(0);
  });

  it('rejects target drift, source-plan drift, and missing experimental opt-in before import', async () => {
    const calls: SpawnCall[] = [];
    const cli = {
      platform: 'linux' as const,
      spawn: queuedSpawner([{ envelope: validInfoFixture }], calls),
    };
    const plan = await buildCmsExecutionPlan({
      sourcePlanFile,
      sourcePlanSha256,
      targetOrg: 'target',
      targetOrgId,
      workspaceMapSha256: 'b'.repeat(64),
      routes: [{ sourceWorkspaceId, targetWorkspaceId, sourceDirectory, packageManifestSha256: manifestSha256 }],
      reportRoot: join(directory, 'reports'),
      cli,
    });

    await rejects(
      () => executeCmsPlan({ plan, targetOrg: fakeOrg(), apply: false, allowExperimental: false, cli }),
      '--allow-experimental-cms is required'
    );
    await rejects(
      () =>
        executeCmsPlan({
          plan,
          targetOrg: fakeOrg('00D000000000009AAA'),
          apply: false,
          allowExperimental: true,
          cli,
        }),
      'target org binding changed'
    );
    await writeFile(sourcePlanFile, '{"schemaVersion":2}\n');
    await rejects(
      () => executeCmsPlan({ plan, targetOrg: fakeOrg(), apply: false, allowExperimental: true, cli }),
      'source migration plan binding changed'
    );
    expect(calls).to.have.length(1);
  });
});
