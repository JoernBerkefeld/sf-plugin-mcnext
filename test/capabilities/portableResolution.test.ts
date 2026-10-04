import { expect } from 'chai';
import { lookupMcnCapability } from '../../src/capabilities/registry.js';
import {
  resolveCampaignPortableIdentity,
  resolveDataSpacePortableIdentity,
  type CampaignResolutionInput,
  type DataSpaceResolutionInput,
} from '../../src/capabilities/portableResolution.js';

const campaignLookup = {
  provider: 'sf-plugin-mcnext',
  family: 'mcnext',
  type: 'Campaign',
  profile: 'relationship-free-scalar-resolver',
} as const;
const dataSpaceLookup = {
  provider: 'sf-plugin-mcnext',
  family: 'mcnext',
  type: 'Data Space',
  profile: 'scope-identity-resolver',
} as const;

function campaignInput(): CampaignResolutionInput {
  return {
    portableName: 'Autumn Campaign',
    context: { businessUnitApiName: 'north' },
    records: [
      {
        serverId: '701000000000001AAA',
        portableName: 'Autumn Campaign',
        context: { businessUnitApiName: 'north' },
        relationships: {
          ParentId: null,
          RecordTypeId: null,
          BriefId: null,
          CampaignImageId: null,
          CampaignMemberRecordTypeId: null,
        },
      },
    ],
    totalSize: 1,
    queryDone: true,
    completion: {
      strategy: 'targeted',
      completionProof: 'exact scalar record match',
      calls: 1,
      items: 1,
      pages: 1,
      complete: true,
    },
  };
}

function dataSpaceInput(): DataSpaceResolutionInput {
  return {
    DataSpaceApiName: 'default',
    records: [{ serverId: '0vh000000000001AAA', DataSpaceApiName: 'default' }],
    totalSize: 1,
    queryDone: true,
    completion: {
      strategy: 'retrieve-all',
      completionProof: 'complete bounded Data Space inventory',
      calls: 1,
      items: 1,
      pages: 1,
      complete: true,
    },
  };
}

describe('MCNext capability runtime registry', () => {
  it('returns only exact canonical Campaign and Data Space declarations', () => {
    expect(lookupMcnCapability(campaignLookup)).to.deep.include({ available: true });
    expect(lookupMcnCapability(dataSpaceLookup)).to.deep.include({ available: true });
    expect(lookupMcnCapability({ ...campaignLookup, profile: 'relationship-aware' })).to.deep.include({
      available: false,
      reason: 'campaign-relationships-unavailable',
    });
  });

  it('blocks inventory inference and unsupported native profiles explicitly', () => {
    const blocked = [
      ['Flow', 'resolver', 'flow-unavailable'],
      ['Data Graph', 'standalone', 'standalone-data-graph-unavailable'],
      ['MarketSegment', 'resolver', 'market-segment-unavailable'],
      ['MarketSegmentDefinition', 'resolver', 'market-segment-definition-unavailable'],
      ['Campaign', 'unknown', 'campaign-relationships-unavailable'],
      ['Data Space', 'unknown', 'unknown-profile'],
    ] as const;
    for (const [type, profile, reason] of blocked) {
      expect(lookupMcnCapability({ provider: 'sf-plugin-mcnext', family: 'mcnext', type, profile })).to.deep.include({
        available: false,
        reason,
      });
    }
    expect(
      lookupMcnCapability({ provider: 'core-sf', family: 'mcnext', type: 'Campaign', profile: campaignLookup.profile })
    ).to.deep.include({ available: false });
  });
});

describe('MCNext portable retrieval resolution', () => {
  it('separates Campaign portable identity from server evidence', () => {
    const result = resolveCampaignPortableIdentity(campaignInput());
    expect(result.portableIdentity).to.deep.equal({
      family: 'mcnext',
      type: 'Campaign',
      apiName: 'Autumn Campaign',
      context: { businessUnitApiName: 'north' },
    });
    expect(result.evidenceIdentity).to.deep.equal({ kind: 'salesforce-id', value: '701000000000001AAA' });
    expect(JSON.stringify(result.portableIdentity)).not.to.include('701000000000001AAA');
  });

  it('blocks ambiguous Campaign names, relationships, incomplete SOQL, and mismatched proof', () => {
    const ambiguous = campaignInput();
    ambiguous.records.push({ ...ambiguous.records[0], serverId: '701000000000002AAA' });
    ambiguous.totalSize = 2;
    ambiguous.completion.items = 2;
    expect(() => resolveCampaignPortableIdentity(ambiguous)).to.throw('uniquely');

    const related = campaignInput();
    related.records[0].relationships.ParentId = '701000000000002AAA';
    expect(() => resolveCampaignPortableIdentity(related)).to.throw('relationships');

    const incomplete = campaignInput();
    incomplete.queryDone = false;
    expect(() => resolveCampaignPortableIdentity(incomplete)).to.throw('SOQL completion');

    const proof = campaignInput();
    proof.completion.completionProof = 'inventory inferred elsewhere';
    expect(() => resolveCampaignPortableIdentity(proof)).to.throw('completion proof');
  });

  it('enforces Campaign hard bounds and rejects portable source-ID leakage', () => {
    const bounded = campaignInput();
    bounded.completion.calls = 6;
    expect(() => resolveCampaignPortableIdentity(bounded)).to.throw('hard bounds');

    const leaked = campaignInput();
    leaked.context = { sourceRecordId: 'portable-looking' };
    leaked.records[0].context = leaked.context;
    expect(() => resolveCampaignPortableIdentity(leaked)).to.throw('portable locator key leak');
  });

  it('resolves Data Space only by exact API-name scope identity', () => {
    const result = resolveDataSpacePortableIdentity(dataSpaceInput());
    expect(result.portableIdentity).to.deep.equal({ family: 'mcnext', type: 'Data Space', apiName: 'default' });
    expect(result.evidenceIdentity).to.deep.equal({
      kind: 'exact-scope',
      value: 'default',
      scope: { serverRecordId: '0vh000000000001AAA' },
    });
    expect(JSON.stringify(result.portableIdentity)).not.to.include('0vh000000000001AAA');
  });

  it('blocks missing or ambiguous DataSpace API names, incomplete evidence, and hard-bound violations', () => {
    const missing = dataSpaceInput();
    missing.records[0].DataSpaceApiName = null;
    expect(() => resolveDataSpacePortableIdentity(missing)).to.throw('DataSpaceApiName');

    const ambiguous = dataSpaceInput();
    ambiguous.records.push({ serverId: '0vh000000000002AAA', DataSpaceApiName: 'default' });
    ambiguous.totalSize = 2;
    ambiguous.completion.items = 2;
    expect(() => resolveDataSpacePortableIdentity(ambiguous)).to.throw('uniquely');

    const incomplete = dataSpaceInput();
    incomplete.totalSize = 2;
    expect(() => resolveDataSpacePortableIdentity(incomplete)).to.throw('SOQL completion');

    const bounded = dataSpaceInput();
    bounded.completion.pages = 6;
    expect(() => resolveDataSpacePortableIdentity(bounded)).to.throw('hard bounds');
  });
});
