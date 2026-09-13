import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestContext } from '@salesforce/core/testSetup';
import { Org } from '@salesforce/core';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import MigrationPlanCommand from '../../../../src/commands/mcnext/migration/plan.js';

function fakeOrg(orgId: string, maximum = '67.0'): Org {
  return {
    getOrgId: () => orgId,
    getConnection: () => ({
      retrieveMaxApiVersion: async () => maximum,
      request: async () => ({}),
    }),
  } as unknown as Org;
}

describe('mcnext migration plan', () => {
  const $$ = new TestContext();
  let directory: string;

  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    directory = await mkdtemp(join(tmpdir(), 'mcnext-command-plan-'));
    $$.SANDBOX.stub(Org, 'create').callsFake(async (options?: object) => {
      const aliasOrUsername = (options as { aliasOrUsername?: string } | undefined)?.aliasOrUsername;
      return fakeOrg(aliasOrUsername === 'source' ? '00Dsource' : '00Dtarget');
    });
  });

  afterEach(async () => {
    $$.restore();
    await rm(directory, { recursive: true, force: true });
  });

  it('writes and returns a read-only deterministic plan contract', async () => {
    const output = join(directory, 'migration-plan.json');
    const result = await MigrationPlanCommand.run([
      '--source-org',
      'source',
      '--target-org',
      'target',
      '--output-file',
      output,
    ]);
    const plan = JSON.parse(await readFile(output, 'utf8')) as { executableTargetPayloads: unknown[]; mode: string };

    expect(result).to.include({
      outputFile: output,
      sourceOrgId: '00Dsource',
      targetOrgId: '00Dtarget',
      preflightPassed: true,
      readOnly: true,
      deferredCmsDependencies: 0,
    });
    expect(result.inventoryItems).to.equal(66);
    expect(plan).to.include({ mode: 'read-only' });
    expect(plan.executableTargetPayloads).to.deep.equal([]);
  });

  it('accepts only minimal opaque CMS evidence', async () => {
    const evidence = join(directory, 'cms.json');
    const output = join(directory, 'migration-plan.json');
    await writeFile(
      evidence,
      JSON.stringify([
        {
          owner: 'cms-service',
          status: 'deferred: cms-service-contract',
          sourceReference: 'opaque-source-id',
          blockedOperation: 'listEmail.deploy',
        },
      ]),
      'utf8'
    );
    const result = await MigrationPlanCommand.run([
      '--source-org',
      'source',
      '--target-org',
      'target',
      '--output-file',
      output,
      '--cms-evidence-file',
      evidence,
    ]);
    expect(result.deferredCmsDependencies).to.equal(1);
  });

  it('rejects CMS payload or mapping fields', async () => {
    const evidence = join(directory, 'cms.json');
    await writeFile(
      evidence,
      JSON.stringify([
        {
          owner: 'cms-service',
          status: 'deferred: cms-service-contract',
          sourceReference: 'opaque-source-id',
          blockedOperation: 'listEmail.deploy',
          payload: { title: 'forbidden' },
        },
      ]),
      'utf8'
    );

    let caught: unknown;
    try {
      await MigrationPlanCommand.run([
        '--source-org',
        'source',
        '--target-org',
        'target',
        '--output-file',
        join(directory, 'migration-plan.json'),
        '--cms-evidence-file',
        evidence,
      ]);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).to.equal('InvalidCmsEvidenceError');
  });
});
