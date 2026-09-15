import { expect } from 'chai';
import CampaignConfig from '../../../../src/commands/mcnext/campaign/config.js';

describe('mcnext campaign config command', () => {
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
