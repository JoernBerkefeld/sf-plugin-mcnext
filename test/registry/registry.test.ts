import { expect } from 'chai';
import { getType, getTypes, MCN_TYPES } from '../../src/registry/registry.js';

describe('type registry', () => {
  it('gives every capability a unique name and explicit ownership state', () => {
    const names = MCN_TYPES.map((type) => type.name);
    expect(new Set(names).size).to.equal(names.length);
    expect(MCN_TYPES.every((type) => type.provider && type.state && Array.isArray(type.operations))).to.equal(true);
  });

  it('requires every core-sf type to declare a delegation', () => {
    for (const type of getTypes({ provider: 'core-sf' })) {
      expect(type.state).to.equal('delegated');
      expect(type.delegation, `${type.name} must declare a delegation`).to.not.equal(undefined);
      expect(Boolean(type.delegation?.metadataType ?? type.delegation?.sObject)).to.equal(true);
    }
  });

  it('presents only proven MCN operations as implemented', () => {
    expect(getType('marketSegmentMember')).to.include({ provider: 'mcnext', state: 'implemented' });
    expect(getType('marketSegmentMember')?.operations).to.deep.equal(['export']);
    expect(getType('identityResolution')?.state).to.equal('implemented');
    expect(getType('identityResolution')?.operations).to.deep.equal(['list', 'retrieve', 'export']);
    expect(getType('identityResolution')?.limitation).to.contain('Configuration only');
    expect(getType('cmsContent')).to.include({ provider: 'cms-service', state: 'conditional' });
    expect(getType('cmsContent')?.operations).to.deep.equal(['export']);
    expect(getType('cmsContent')?.limitation).to.contain('sf mcnext migration plan --cms-plan');
    expect(getType('cmsContent')?.limitation).to.contain(
      'separately installed sf-plugin-cms >=0.3.1 versioned CLI contract'
    );
    expect(getType('cmsContent')?.limitation).to.contain(
      'MCN owns no CMS content retrieval, import, deployment, payload rewriting, or execution'
    );
    expect(getTypes({ state: 'implemented' }).map((type) => type.name)).to.deep.equal([
      'marketSegmentMember',
      'identityResolution',
    ]);
  });

  it('keeps segment definition, records, and computed membership distinct', () => {
    expect(getType('marketSegmentDefinition')?.delegation?.metadataType).to.equal('MarketSegmentDefinition');
    expect(getType('marketSegmentRecord')?.delegation?.sObject).to.equal('MarketSegment');
    expect(getType('marketSegmentMember')?.provider).to.equal('mcnext');
  });

  it('selects only MarketSegment fields confirmed by the v67 describe', () => {
    const fields = getType('marketSegmentRecord')?.delegation?.fields ?? [];
    expect(fields).to.include('SegmentStatus');
    expect(fields).to.include('PublishStatus');
    expect(fields).to.not.include('Status');
  });

  it('delegates only to metadata types confirmed in the v67 SDO', () => {
    const confirmed = new Set([
      'Flow',
      'FlowDefinition',
      'FlowTest',
      'ManagedContentType',
      'ContentTypeBundle',
      'MarketSegmentDefinition',
    ]);
    for (const type of getTypes({ provider: 'core-sf' })) {
      const metadataType = type.delegation?.metadataType;
      if (metadataType) {
        expect(confirmed.has(metadataType), `${metadataType} is not probe-confirmed`).to.equal(true);
      }
    }
  });
});
