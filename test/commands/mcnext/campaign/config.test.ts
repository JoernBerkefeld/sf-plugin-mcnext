import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import CampaignConfig, { campaignConfigServices } from '../../../../src/commands/mcnext/campaign/config.js';
import { type CampaignResult } from '../../../../src/core/campaignCli.js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
} from '../../../../src/filesystem/runOwnedTemp.js';

describe('mcnext campaign config command', () => {
  const $$ = new TestContext();
  afterEach(() => $$.restore());

  it('writes only the flat snapshot, returns diagnostics in human/JSON modes and never clobbers output', async () => {
    const run = await createRunOwnedTemp('campaign-command');
    const project = await createRunOwnedDirectory(run, 'project');
    const exported: CampaignResult = {
      operation: 'export',
      targetId: '701000000000001AAA',
      artifact: { Id: '701000000000001AAA', Description: null, Name: '', IsActive: false, ActualCost: 0 },
      diagnostics: {
        snapshot: 'incomplete',
        omittedFields: ['Custom__c'],
        associatedArtifacts: {
          status: 'incomplete',
          reason: 'Not a full backup',
          flows: [
            {
              record: { Id: '2aF000000000001AAA', AssociatedRecordId: '701000000000001AAA', SegmentId: null },
              status: 'blocked',
              reason: 'Missing Tooling definition',
            },
          ],
        },
      },
    };
    stubSfCommandUx($$.SANDBOX);
    $$.SANDBOX.stub(campaignConfigServices, 'runCampaign').resolves(exported);
    const args = [
      '--operation',
      'export',
      '--target-org',
      'target',
      '--expected-org-id',
      '00D000000000001AAA',
      '--api-version',
      '67.0',
      '--project-dir',
      project,
      '--record-id',
      exported.targetId,
    ];
    try {
      await Promise.all(
        [false, true].map(async (json) => {
          const name = json ? 'json.json' : 'human.json';
          const actual = await CampaignConfig.run([...args, '--output-file', name, ...(json ? ['--json'] : [])]);
          expect(actual).to.deep.equal(exported);
          expect(JSON.parse(await readFile(join(project, name), 'utf8'))).to.deep.equal(exported.artifact);
        })
      );
      await writeFile(join(project, 'sentinel.json'), 'existing output', { flag: 'wx' });
      await Promise.all(
        ['sentinel.json', 'missing/output.json'].map(async (output) => {
          let error: unknown;
          try {
            await CampaignConfig.run([...args, '--output-file', output]);
          } catch (caught) {
            error = caught;
          }
          expect(String(error)).to.include(output.startsWith('missing') ? 'ENOENT' : 'EEXIST');
        })
      );
      expect(await readFile(join(project, 'sentinel.json'), 'utf8')).to.equal('existing output');
      expect(JSON.parse(await readFile(join(project, 'human.json'), 'utf8'))).to.deep.equal(exported.artifact);
    } finally {
      await removeRunOwnedPath(run, project);
      await removeRunOwnedRoot(run);
    }
  });
  it('requires explicit operation, org identity, API version and directory', () => {
    expect(CampaignConfig.flags.operation.options).to.deep.equal(['export', 'create', 'update']);
    for (const flag of ['operation', 'target-org', 'expected-org-id', 'api-version', 'project-dir'] as const)
      expect(CampaignConfig.flags[flag].required).to.equal(true);
    expect(CampaignConfig.description).to.include('real command roundtrip acceptance');
  });
  it('rejects export without output before calling Core', async () => {
    let error: unknown;
    try {
      await CampaignConfig.run([
        '--operation',
        'export',
        '--target-org',
        'target',
        '--expected-org-id',
        '00D000000000001AAA',
        '--api-version',
        '67.0',
        '--project-dir',
        '.',
      ]);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.include('Export requires output-file only');
  });
});
