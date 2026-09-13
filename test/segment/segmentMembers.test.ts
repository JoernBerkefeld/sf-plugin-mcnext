import { Connection, Org } from '@salesforce/core';
import { expect } from 'chai';
import { McnClient } from '../../src/client/mcnClient.js';
import {
  getSegmentMembers,
  resolveSegmentApiName,
} from '../../src/segment/segmentMembers.js';

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

describe('segment-member service', () => {
  it('uses a valid API name from the segment detail endpoint', async () => {
    const { client, urls } = await clientReturning([{ apiName: 'Annual_Promo' }]);

    expect(await resolveSegmentApiName(client, 'Annual_Promo')).to.equal('Annual_Promo');
    expect(urls).to.deep.equal(['/services/data/v67.0/ssot/segments/Annual_Promo']);
  });

  it('resolves an API name through the segment list when detail lookup is unavailable', async () => {
    const notFound = Object.assign(new Error('Segment not found'), { errorCode: 'ITEM_NOT_FOUND' });
    const { client } = await clientReturning([
      notFound,
      { segments: [{ apiName: 'Annual_Promo' }], batchSize: 1, offset: 0, totalSize: 1 },
    ]);

    expect(await resolveSegmentApiName(client, 'Annual_Promo')).to.equal('Annual_Promo');
  });

  it('resolves a MarketSegment ID or exact display name through the segment list', async () => {
    const notFound = Object.assign(new Error('Segment not found'), { errorCode: 'ITEM_NOT_FOUND' });
    const segment = {
      apiName: 'Annual_Promo',
      displayName: 'Annual Promo',
      marketSegmentId: '1sg000000000001',
    };
    const byId = await clientReturning([notFound, { segments: [segment], batchSize: 1, offset: 0, totalSize: 1 }]);
    const byName = await clientReturning([notFound, { segments: [segment], batchSize: 1, offset: 0, totalSize: 1 }]);

    expect(await resolveSegmentApiName(byId.client, segment.marketSegmentId)).to.equal('Annual_Promo');
    expect(await resolveSegmentApiName(byName.client, segment.displayName)).to.equal('Annual_Promo');
  });

  it('preserves ITEM_NOT_FOUND when neither detail nor list resolves the selection', async () => {
    const notFound = Object.assign(new Error('Segment not found: Missing'), { errorCode: 'ITEM_NOT_FOUND' });
    const { client } = await clientReturning([
      notFound,
      { segments: [], batchSize: 200, offset: 0, totalSize: 0 },
    ]);

    const error = await captureError(resolveSegmentApiName(client, 'Missing'));
    expect(error.name).to.equal('ITEM_NOT_FOUND');
    expect(error.message).to.contain('Segment not found: Missing');
  });

  it('parses data and safely follows the observed nextPageUrl', async () => {
    const { client, urls } = await clientReturning([
      { apiName: 'Annual_Promo' },
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
    const { client } = await clientReturning([{ apiName: 'Annual_Promo' }, invalidInput]);

    const error = await captureError(
      getSegmentMembers(client, 'Annual_Promo', { fields: 'DefinitelyNotARealMemberField__c', limit: 1 })
    );
    expect(error.name).to.equal('INVALID_API_INPUT');
    expect(error.message).to.contain('Invalid value for FIELDS');
  });
});
