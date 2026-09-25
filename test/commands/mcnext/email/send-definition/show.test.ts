import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import SendDefinitionShow from '../../../../../src/commands/mcnext/email/send-definition/show.js';

describe('mcnext email send-definition show', () => {
  const $$ = new TestContext();

  afterEach(() => $$.restore());

  it('delegates an exact ListEmail record read to core sf', async () => {
    const command = Object.create(SendDefinitionShow.prototype) as SendDefinitionShow;
    const runCommand = $$.SANDBOX.stub().resolves({ Id: '0XB000000000001AAA' });
    Object.assign(command, {
      config: { runCommand },
      log: $$.SANDBOX.stub(),
      parse: $$.SANDBOX.stub().resolves({
        flags: { 'target-org': 'my-org', 'record-id': '0XB000000000001AAA', 'api-version': '67.0' },
      }),
    });

    const result = await command.run();
    expect(
      runCommand.calledOnceWithExactly('data get record', [
        '--sobject',
        'ListEmail',
        '--record-id',
        '0XB000000000001AAA',
        '--target-org',
        'my-org',
        '--api-version',
        '67.0',
      ])
    ).to.equal(true);
    expect(result.result).to.deep.equal({ Id: '0XB000000000001AAA' });
  });
});
