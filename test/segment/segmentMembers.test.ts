import { Connection, Org } from '@salesforce/core';
import { expect } from 'chai';
import { McnClient } from '../../src/client/mcnClient.js';
import { getSegmentMembers, resolveSegmentApiName } from '../../src/segment/segmentMembers.js';

type RequestArgs = { method: string; url: string };

async function clientReturning(responses: unknown[]): Promise<{ client: McnClient; urls: string[] }> {
  const urls: string[] = [];
  let call = 0;
  const connection = {
    instanceUrl: 'https://example.my.salesforce.com',
    retrieveMaxApiVersion: async () => '67.0',
    request: async (args: RequestArgs) => {
      urls.push(args.url);
      const response = responses[call++];
      if (response instanceof Error) throw response;
      return response;
    },
  } as unknown as Connection;
  const org = { getConnection: () => connection } as unknown as Org;
  return { client: await McnClient.create(org), urls };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected promise to reject');
}

const notFound = (): Error => Object.assign(new Error('Segment not found'), { errorCode: 'ITEM_NOT_FOUND' });
const listEnvelope = (segments: Array<Record<string, unknown>>): Record<string, unknown> => ({
  segments,
  batchSize: segments.length || 200,
  offset: 0,
  totalSize: segments.length,
});

describe('segment-member service', () => {
  it('uses a valid API name from the segment detail envelope', async () => {
    const { client, urls } = await clientReturning([{ segments: [{ apiName: 'Annual_Promo' }] }]);

    expect(await resolveSegmentApiName(client, 'Annual_Promo')).to.equal('Annual_Promo');
    expect(urls).to.deep.equal(['/services/data/v67.0/ssot/segments/Annual_Promo']);
  });

  it('resolves an exact 18-character MarketSegment ID through the segment list', async () => {
    const segment = { apiName: 'Annual_Promo', marketSegmentId: '1sg000000000001AAA' };
    const { client } = await clientReturning([notFound(), listEnvelope([segment])]);

    expect(await resolveSegmentApiName(client, segment.marketSegmentId)).to.equal('Annual_Promo');
  });

  it('resolves an exact 15-character MarketSegment ID through the segment list', async () => {
    const segment = { apiName: 'Annual_Promo', marketSegmentId: '1sg000000000001' };
    const { client } = await clientReturning([notFound(), listEnvelope([segment])]);

    expect(await resolveSegmentApiName(client, segment.marketSegmentId)).to.equal('Annual_Promo');
  });

  it('resolves an exact case-sensitive display name through the segment list', async () => {
    const segment = { apiName: 'Annual_Promo', displayName: 'Annual Promo' };
    const exact = await clientReturning([notFound(), listEnvelope([segment])]);
    const wrongCase = await clientReturning([notFound(), listEnvelope([segment])]);

    expect(await resolveSegmentApiName(exact.client, segment.displayName)).to.equal('Annual_Promo');
    expect((await captureError(resolveSegmentApiName(wrongCase.client, 'annual promo'))).name).to.equal('ITEM_NOT_FOUND');
  });

  it('rejects ambiguous exact display-name matches', async () => {
    const { client } = await clientReturning([
      notFound(),
      listEnvelope([
        { apiName: 'First', displayName: 'Duplicate' },
        { apiName: 'Second', displayName: 'Duplicate' },
      ]),
    ]);

    const error = await captureError(resolveSegmentApiName(client, 'Duplicate'));
    expect(error.name).to.equal('AmbiguousSegmentError');
    expect(error.message).to.contain('ambiguous');
  });

  for (const [label, response] of [
    ['empty segments', { segments: [] }],
    ['multiple segments', { segments: [{ apiName: 'First' }, { apiName: 'Second' }] }],
    ['missing apiName', { segments: [{}] }],
    ['whitespace apiName', { segments: [{ apiName: '   ' }] }],
  ] as const) {
    it(`fails closed for a successful detail response with ${label}`, async () => {
      const { client, urls } = await clientReturning([response, listEnvelope([{ apiName: 'Fallback' }])]);

      const error = await captureError(resolveSegmentApiName(client, 'Selection'));
      expect(error.name).to.equal('InvalidSegmentDetailResponse');
      expect(error.message).to.equal(
        'Segment detail response must contain exactly one segment with a non-empty apiName.'
      );
      expect(urls).to.deep.equal(['/services/data/v67.0/ssot/segments/Selection']);
    });
  }

  it('preserves ITEM_NOT_FOUND when neither detail nor list resolves the selection', async () => {
    const missing = Object.assign(new Error('Segment not found: Missing'), { errorCode: 'ITEM_NOT_FOUND' });
    const { client } = await clientReturning([missing, listEnvelope([])]);

    const error = await captureError(resolveSegmentApiName(client, 'Missing'));
    expect(error.name).to.equal('ITEM_NOT_FOUND');
    expect(error.message).to.contain('Segment not found: Missing');
  });

  it('parses data and safely follows the observed nextPageUrl', async () => {
    const { client, urls } = await clientReturning([
      { segments: [{ apiName: 'Annual_Promo' }] },
      {
        data: [{ id: 'opaque-a', deltaType: 'new' }],
        limit: 1,
        offSet: 0,
        rowCount: 1,
        totalCount: 2,
        nextPageUrl:
          '/services/data/v67.0/ssot/segments/Annual_Promo/members?filters=Delta_Type__c+in+%28%27new%27%29&limit=1&offset=1&orderBy=Id__c+asc&fields=Id__c%2CDelta_Type__c',
      },
      { data: [{ id: 'opaque-b', deltaType: 'new' }], limit: 1, offSet: 1, rowCount: 1, totalCount: 2 },
    ]);

    const result = await getSegmentMembers(client, 'Annual_Promo', {
      fields: 'Id__c,Delta_Type__c',
      filters: "Delta_Type__c in ('new')",
      orderBy: 'Id__c asc',
      limit: 1,
      offset: 0,
      paginationLimits: { maxPages: 2, maxItems: 2, maxDurationMs: 1000 },
    });

    expect(result).to.deep.equal({
      segmentApiName: 'Annual_Promo',
      data: [
        { id: 'opaque-a', deltaType: 'new' },
        { id: 'opaque-b', deltaType: 'new' },
      ],
    });
    expect(urls).to.deep.equal([
      '/services/data/v67.0/ssot/segments/Annual_Promo',
      '/services/data/v67.0/ssot/segments/Annual_Promo/members?fields=Id__c%2CDelta_Type__c&filters=Delta_Type__c+in+%28%27new%27%29&orderBy=Id__c+asc&limit=1&offset=0',
      '/services/data/v67.0/ssot/segments/Annual_Promo/members?filters=Delta_Type__c+in+%28%27new%27%29&limit=1&offset=1&orderBy=Id__c+asc&fields=Id__c%2CDelta_Type__c',
    ]);
  });

  it('preserves INVALID_API_INPUT from the members endpoint', async () => {
    const invalidInput = Object.assign(new Error('Invalid value for FIELDS'), { errorCode: 'INVALID_API_INPUT' });
    const { client } = await clientReturning([{ segments: [{ apiName: 'Annual_Promo' }] }, invalidInput]);

    const error = await captureError(
      getSegmentMembers(client, 'Annual_Promo', { fields: 'DefinitelyNotARealMemberField__c', limit: 1 })
    );
    expect(error.name).to.equal('INVALID_API_INPUT');
    expect(error.message).to.contain('Invalid value for FIELDS');
  });
});
