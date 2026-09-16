import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import ListTypes from '../../../../src/commands/mcnext/list/types.js';

describe('mcnext list types', () => {
  const $$ = new TestContext();

  beforeEach(() => {
    stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    $$.restore();
  });

  it('lists ownership, state, and operations for every capability', async () => {
    const result = await ListTypes.run([]);
    expect(result.length).to.be.greaterThan(0);
    expect(result.some((row) => row.state === 'delegated')).to.equal(true);
    expect(result.some((row) => row.state === 'conditional')).to.equal(true);
    expect(result.every((row) => Array.isArray(row.operations))).to.equal(true);
  });

  it('filters MCN-owned capabilities with explicit support boundaries', async () => {
    const result = await ListTypes.run(['--provider', 'mcnext']);
    expect(result.length).to.equal(3);
    expect(result.filter((row) => row.state === 'implemented').length).to.equal(2);
    expect(result.find((row) => row.name === 'identityResolution')?.operations).to.deep.equal([
      'list',
      'retrieve',
      'export',
    ]);
    expect(result.find((row) => row.name === 'identityResolution')?.limitation).to.contain('Configuration only');
    expect(result.every((row) => row.delegatedTo === '')).to.equal(true);
  });

  it('shows provider-owned CMS export evidence as planning-only and conditional', async () => {
    const result = await ListTypes.run(['--provider', 'cms-service']);
    expect(result.map((row) => row.name)).to.deep.equal(['cmsContent']);
    expect(result[0]).to.include({ provider: 'cms-service', state: 'conditional', delegatedTo: '' });
    expect(result[0]?.operations).to.deep.equal(['export']);
    expect(result[0]?.limitation).to.contain('sf mcnext migration plan --cms-plan');
    expect(result[0]?.limitation).to.contain('separately installed sf-plugin-cms >=0.4.0 versioned CLI contract');
    expect(result[0]?.limitation).to.contain(
      'MCN owns no CMS content retrieval, import, deployment, payload rewriting, or execution'
    );
  });

  it('names the exact core command for delegated metadata', async () => {
    const result = await ListTypes.run(['--provider', 'core-sf']);
    const flow = result.find((row) => row.name === 'flow');
    expect(flow?.delegatedTo).to.equal('sf project retrieve start -m Flow');
  });
});
