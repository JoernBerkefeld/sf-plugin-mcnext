import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import ListTypes from '../../../../src/commands/mcnext/list/types.js';

describe('mcnext list types', () => {
  const $$ = new TestContext();

  beforeEach(() => {
    stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    $$.restore();
  });

  it('lists every type by default', async () => {
    const result = await ListTypes.run([]);
    expect(result.length).to.be.greaterThan(0);
    expect(result.some((row) => row.coverage === 'gap')).to.equal(true);
    expect(result.some((row) => row.coverage === 'core-sf')).to.equal(true);
  });

  it('restricts output with --coverage gap', async () => {
    const result = await ListTypes.run(['--coverage', 'gap']);
    expect(result.every((row) => row.coverage === 'gap')).to.equal(true);
    expect(result.every((row) => row.delegatedTo === '- (this plugin)')).to.equal(true);
  });

  it('names the exact core command for delegated types', async () => {
    const result = await ListTypes.run(['--coverage', 'core-sf']);
    const flow = result.find((row) => row.name === 'flow');
    expect(flow?.delegatedTo).to.equal('sf project retrieve start -m Flow');
  });
});
