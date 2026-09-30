import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Org } from '@salesforce/core';
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import MigrationCmsCommand, { cmsExecutionServices } from '../../../../src/commands/mcnext/migration/cms.js';
import type { CmsExecutionPlan, CmsExecutionResult } from '../../../../src/migration/cmsExecution.js';

const targetOrgId = '00D000000000001AAA';
const readySource = '0Zu000000000001AAA';
const blockedSource = '0Zu000000000002AAA';
const readyTarget = '0Zu000000000003AAA';
const blockedTarget = '0Zu000000000004AAA';
const readyHash = 'a'.repeat(64);
const blockedHash = 'b'.repeat(64);

function fakeExecutionPlan(): CmsExecutionPlan {
  return {
    contract: 'sf-mcnext-cms-execution-plan',
    contractVersion: '1.0.0',
    planId: 'plan-id',
    sourcePlanFile: 'plan.json',
    sourcePlanSha256: 'c'.repeat(64),
    targetOrgId,
    targetOrg: 'target',
    provider: {
      name: 'sf-plugin-cms',
      version: '1.0.0',
      infoContractMajor: 1,
      importContractMajor: 1,
    },
    workspaceMapSha256: 'd'.repeat(64),
    experimental: true,
    routes: [],
  };
}

function fakeResult(): CmsExecutionResult {
  return {
    contract: 'sf-mcnext-cms-execution-result',
    contractVersion: '1.0.0',
    planId: 'plan-id',
    mode: 'dry-run',
    status: 'success',
    completedRoutes: [],
  };
}

describe('mcnext migration cms', () => {
  const $$ = new TestContext();
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcnext-command-cms-'));
    $$.SANDBOX.stub(Org, 'create').resolves({ getOrgId: () => targetOrgId } as Org);
  });

  afterEach(async () => {
    $$.restore();
    await rm(directory, { recursive: true, force: true });
  });

  it('passes only the ready, successful, explicitly bound route to execution', async () => {
    const planFile = join(directory, 'plan.json');
    const resultFile = join(directory, 'result.json');
    await writeFile(
      planFile,
      JSON.stringify({
        schemaVersion: 1,
        mode: 'read-only',
        targetOrgId,
        cmsPlanning: {
          state: 'partial',
          workspaceMap: { sha256: 'd'.repeat(64) },
          packages: [
            { sourceWorkspaceId: readySource, artifactPath: join(directory, 'ready'), packageManifestSha256: readyHash },
            {
              sourceWorkspaceId: blockedSource,
              artifactPath: join(directory, 'blocked'),
              packageManifestSha256: blockedHash,
            },
          ],
          routes: [
            {
              sourceWorkspaceId: readySource,
              targetWorkspaceId: readyTarget,
              packageManifestSha256: readyHash,
              status: 'success',
              state: 'ready-for-execution',
            },
            {
              sourceWorkspaceId: blockedSource,
              targetWorkspaceId: blockedTarget,
              packageManifestSha256: blockedHash,
              status: 'partial',
              state: 'blocked',
            },
          ],
        },
      })
    );
    const buildPlan = $$.SANDBOX.stub(cmsExecutionServices, 'buildPlan').resolves(fakeExecutionPlan());
    const executePlan = $$.SANDBOX.stub(cmsExecutionServices, 'executePlan').resolves(fakeResult());
    $$.SANDBOX.stub(cmsExecutionServices, 'writeResult').resolves();

    await MigrationCmsCommand.run([
      '--target-org',
      'target',
      '--expected-target-org-id',
      targetOrgId,
      '--plan-file',
      planFile,
      '--result-file',
      resultFile,
      '--report-root',
      join(directory, 'reports'),
      '--allow-experimental-cms',
    ]);

    expect(buildPlan.calledOnce).to.equal(true);
    expect(buildPlan.firstCall.args[0].routes).to.deep.equal([
      {
        sourceWorkspaceId: readySource,
        targetWorkspaceId: readyTarget,
        sourceDirectory: join(directory, 'ready'),
        packageManifestSha256: readyHash,
      },
    ]);
    expect(executePlan.calledOnce).to.equal(true);
  });

  for (const scenario of [
    { name: 'non-ready state', route: { state: 'blocked' } },
    { name: 'non-success status', route: { status: 'partial' } },
    { name: 'empty target', route: { targetWorkspaceId: '' } },
    { name: 'missing target', route: { targetWorkspaceId: undefined } },
    { name: 'missing manifest hash', route: { packageManifestSha256: undefined } },
    { name: 'missing package evidence', packages: [] },
    { name: 'mismatched package hash', packageHash: blockedHash },
  ] as const) {
    it(`rejects ${scenario.name} before provider discovery`, async () => {
      const planFile = join(directory, 'plan.json');
      const route = {
        sourceWorkspaceId: readySource,
        targetWorkspaceId: readyTarget,
        packageManifestSha256: readyHash,
        status: 'success',
        state: 'ready-for-execution',
        ...scenario.route,
      };
      await writeFile(
        planFile,
        JSON.stringify({
          schemaVersion: 1,
          mode: 'read-only',
          targetOrgId,
          cmsPlanning: {
            state: 'partial',
            workspaceMap: { sha256: 'd'.repeat(64) },
            packages:
              'packages' in scenario
                ? scenario.packages
                : [
                    {
                      sourceWorkspaceId: readySource,
                      artifactPath: join(directory, 'ready'),
                      packageManifestSha256: 'packageHash' in scenario ? scenario.packageHash : readyHash,
                    },
                  ],
            routes: [route],
          },
        })
      );
      const buildPlan = $$.SANDBOX.stub(cmsExecutionServices, 'buildPlan');
      const executePlan = $$.SANDBOX.stub(cmsExecutionServices, 'executePlan');

      let caught: unknown;
      try {
        await MigrationCmsCommand.run([
          '--target-org',
          'target',
          '--expected-target-org-id',
          targetOrgId,
          '--plan-file',
          planFile,
          '--result-file',
          join(directory, 'result.json'),
          '--report-root',
          join(directory, 'reports'),
          '--allow-experimental-cms',
        ]);
      } catch (error) {
        caught = error;
      }

      expect((caught as Error).name).to.equal('CmsRouteNotExecutable');
      expect(buildPlan.called).to.equal(false);
      expect(executePlan.called).to.equal(false);
    });
  }

  it('fails before provider execution when no route is executable', async () => {
    const planFile = join(directory, 'plan.json');
    await writeFile(
      planFile,
      JSON.stringify({
        schemaVersion: 1,
        mode: 'read-only',
        targetOrgId,
        cmsPlanning: {
          state: 'blocked',
          workspaceMap: { sha256: 'd'.repeat(64) },
          packages: [
            {
              sourceWorkspaceId: blockedSource,
              artifactPath: join(directory, 'blocked'),
              packageManifestSha256: blockedHash,
            },
          ],
          routes: [
            {
              sourceWorkspaceId: blockedSource,
              targetWorkspaceId: blockedTarget,
              packageManifestSha256: blockedHash,
              status: 'partial',
              state: 'blocked',
            },
          ],
        },
      })
    );
    const buildPlan = $$.SANDBOX.stub(cmsExecutionServices, 'buildPlan');
    const executePlan = $$.SANDBOX.stub(cmsExecutionServices, 'executePlan');

    let caught: unknown;
    try {
      await MigrationCmsCommand.run([
        '--target-org',
        'target',
        '--expected-target-org-id',
        targetOrgId,
        '--plan-file',
        planFile,
        '--result-file',
        join(directory, 'result.json'),
        '--report-root',
        join(directory, 'reports'),
        '--allow-experimental-cms',
      ]);
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).name).to.equal('CmsRouteNotExecutable');
    expect(buildPlan.called).to.equal(false);
    expect(executePlan.called).to.equal(false);
  });
});
