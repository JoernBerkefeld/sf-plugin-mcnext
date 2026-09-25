import { Connection, Org } from '@salesforce/core';
import { expect } from 'chai';
import { McnClient, TESTED_API_VERSION } from '../../src/client/mcnClient.js';

type RequestArgs = { method: string; url: string };

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected promise to reject');
}

async function clientReturning(
  pages: unknown[],
  instanceUrl = 'https://example.my.salesforce.com'
): Promise<{ client: McnClient; urls: string[] }> {
  const urls: string[] = [];
  let call = 0;
  const connection = {
    instanceUrl,
    retrieveMaxApiVersion: async () => '67.0',
    request: async (args: RequestArgs) => {
      urls.push(args.url);
      return pages[call++];
    },
  } as unknown as Connection;
  const org = { getConnection: () => connection } as unknown as Org;
  return { client: await McnClient.create(org), urls };
}

describe('McnClient', () => {
  it('defaults to the tested v67 baseline instead of the org maximum', async () => {
    const versions: Array<string | undefined> = [];
    const connection = {
      retrieveMaxApiVersion: async () => '68.0',
      request: async () => ({}),
    } as unknown as Connection;
    const org = {
      getConnection: (version?: string) => {
        versions.push(version);
        return connection;
      },
    } as unknown as Org;

    const client = await McnClient.create(org);
    expect(client.apiVersion).to.equal(TESTED_API_VERSION);
    expect(versions).to.deep.equal([undefined, '67.0']);
  });

  it('rejects untested explicit API versions', async () => {
    const org = { getConnection: () => ({}) } as unknown as Org;
    const error = await captureError(McnClient.create(org, '68.0'));
    expect(error.message).to.contain('tested only with v67.0');
  });

  it('reads a single endpoint array without inventing pagination parameters', async () => {
    const { client, urls } = await clientReturning([{ spaces: [{ id: '1' }, { id: '2' }] }]);
    const result = await client.requestAll<{ id: string }>({ path: '/connect/cms/spaces', itemsKey: 'spaces' });
    expect(result.map((row) => row.id)).to.deep.equal(['1', '2']);
    expect(urls).to.deep.equal(['/services/data/v67.0/connect/cms/spaces']);
  });

  it('follows an org-relative next-page pointer', async () => {
    const { client, urls } = await clientReturning([
      { records: [{ Id: 'a' }], nextRecordsUrl: '/services/data/v67.0/query/01g-2000' },
      { records: [{ Id: 'b' }] },
    ]);
    const result = await client.requestAll<{ Id: string }>({ path: '/query', query: { q: 'SELECT Id FROM Contact' } });
    expect(result.map((row) => row.Id)).to.deep.equal(['a', 'b']);
    expect(urls[1]).to.equal('/services/data/v67.0/query/01g-2000');
  });

  it('accepts a same-origin absolute pointer as an org-relative URL', async () => {
    const { client, urls } = await clientReturning([
      { records: [{ Id: 'a' }], nextRecordsUrl: 'https://example.my.salesforce.com/services/data/v67.0/query/next' },
      { records: [] },
    ]);
    await client.requestAll({ path: '/query' });
    expect(urls[1]).to.equal('/services/data/v67.0/query/next');
  });

  it('rejects a cross-origin pagination pointer', async () => {
    const { client } = await clientReturning([
      { records: [{ Id: 'a' }], nextRecordsUrl: 'https://attacker.example/services/data/v67.0/query/next' },
    ]);
    const error = await captureError(client.requestAll({ path: '/query' }));
    expect(error.message).to.contain('different origin');
  });

  it('rejects a network-path pagination pointer', async () => {
    const { client, urls } = await clientReturning([
      { records: [{ Id: 'a' }], nextRecordsUrl: '//attacker.example/services/data/v67.0/query/next' },
    ]);
    const error = await captureError(client.requestAll({ path: '/query' }));
    expect(error.message).to.contain('unsafe network path');
    expect(urls).to.deep.equal(['/services/data/v67.0/query']);
  });

  it('detects a repeated pagination pointer', async () => {
    const pointer = '/services/data/v67.0/query/next';
    const { client } = await clientReturning([
      { records: [{ Id: 'a' }], nextRecordsUrl: pointer },
      { records: [{ Id: 'b' }], nextRecordsUrl: pointer },
    ]);
    const error = await captureError(client.requestAll({ path: '/query' }));
    expect(error.message).to.contain('repeated pointer');
  });

  it('walks the observed ssot offset convention only when configured', async () => {
    const { client, urls } = await clientReturning([
      { segments: [{ id: 's1' }, { id: 's2' }], batchSize: 2, offset: 4, totalSize: 7 },
      { segments: [{ id: 's3' }], batchSize: 2, offset: 6, totalSize: 7 },
    ]);
    const result = await client.requestAll<{ id: string }>(
      { path: '/ssot/segments', itemsKey: 'segments', pageSizeParam: 'batchSize', query: { offset: 4 } },
      2
    );
    expect(result.map((row) => row.id)).to.deep.equal(['s1', 's2', 's3']);
    expect(urls[0]).to.equal('/services/data/v67.0/ssot/segments?offset=4&batchSize=2');
    expect(urls[1]).to.equal('/services/data/v67.0/ssot/segments?offset=6&batchSize=2');
  });

  it('fails strict completeness for malformed and inconsistent pagination metadata', async () => {
    const scenarios = [
      { segments: [], batchSize: 1, offset: 0 },
      { segments: [{ id: 's1' }], batchSize: 1, totalSize: 2 },
      { segments: [{ id: 's1' }], batchSize: 0, offset: 0, totalSize: 2 },
      { segments: [{ id: 's1' }], batchSize: 2, offset: 0, totalSize: 3 },
      { segments: [{ id: 's1' }], batchSize: 1, offset: 1, totalSize: 2 },
    ];
    for (const page of scenarios) {
      // eslint-disable-next-line no-await-in-loop -- each malformed envelope needs an isolated client
      const { client } = await clientReturning([page]);
      // eslint-disable-next-line no-await-in-loop -- each malformed envelope is independently rejected
      const error = await captureError(
        client.requestAll(
          {
            path: '/ssot/segments',
            itemsKey: 'segments',
            pageSizeParam: 'batchSize',
            requireItemsKey: true,
            requireCompletePagination: true,
          },
          1
        )
      );
      expect(error.name).to.equal('PaginationEnvelopeError');
    }
  });

  it('fails strict completeness when a later page omits totals', async () => {
    const missingTotal = await clientReturning([
      { segments: [{ id: 's1' }], batchSize: 1, offset: 0, totalSize: 2 },
      { segments: [{ id: 's2' }], batchSize: 1, offset: 1 },
    ]);
    const error = await captureError(
      missingTotal.client.requestAll(
        {
          path: '/ssot/segments',
          itemsKey: 'segments',
          pageSizeParam: 'batchSize',
          requireItemsKey: true,
          requireCompletePagination: true,
        },
        1
      )
    );
    expect(error.name).to.equal('PaginationEnvelopeError');
    expect(error.message).to.contain('total count');
  });

  it('fails strict completeness for a malformed later page and a non-forward pointer', async () => {
    const malformedLater = await clientReturning([
      { segments: [{ id: 's1' }], batchSize: 1, offset: 0, totalSize: 2 },
      { segments: [{ id: 's2' }], batchSize: 1, offset: 0, totalSize: 2 },
    ]);
    const laterError = await captureError(
      malformedLater.client.requestAll(
        {
          path: '/ssot/segments',
          itemsKey: 'segments',
          pageSizeParam: 'batchSize',
          requireItemsKey: true,
          requireCompletePagination: true,
        },
        1
      )
    );
    expect(laterError.message).to.contain('inconsistent');

    const nonForward = await clientReturning([
      {
        segments: [{ id: 's1' }],
        batchSize: 1,
        offset: 0,
        totalSize: 2,
        nextPageUrl: '/services/data/v67.0/ssot/segments?batchSize=1&offset=0',
      },
    ]);
    const pointerError = await captureError(
      nonForward.client.requestAll(
        {
          path: '/ssot/segments',
          itemsKey: 'segments',
          pageSizeParam: 'batchSize',
          requireItemsKey: true,
          requireCompletePagination: true,
        },
        1
      )
    );
    expect(pointerError.message).to.contain('expected offset');
  });

  it('follows the observed segment-member nextPageUrl with offSet metadata', async () => {
    const { client, urls } = await clientReturning([
      {
        data: [{ id: 'opaque-a' }],
        limit: 1,
        offSet: 0,
        totalCount: 2,
        nextPageUrl: '/services/data/v67.0/ssot/segments/Annual_Promo/members?limit=1&offset=1',
      },
      { data: [{ id: 'opaque-b' }], limit: 1, offSet: 1, totalCount: 2 },
    ]);
    const result = await client.requestAll<{ id: string }>(
      {
        path: '/ssot/segments/Annual_Promo/members',
        itemsKey: 'data',
        query: { limit: 1, offset: 0 },
      },
      1
    );
    expect(result.map((row) => row.id)).to.deep.equal(['opaque-a', 'opaque-b']);
    expect(urls).to.deep.equal([
      '/services/data/v67.0/ssot/segments/Annual_Promo/members?limit=1&offset=0',
      '/services/data/v67.0/ssot/segments/Annual_Promo/members?limit=1&offset=1',
    ]);
  });

  it('enforces page and item bounds', async () => {
    const pageLimited = await clientReturning([
      { records: [{ Id: 'a' }], nextRecordsUrl: '/services/data/v67.0/query/next' },
    ]);
    const pageError = await captureError(pageLimited.client.requestAll({ path: '/query' }, 200, { maxPages: 1 }));
    expect(pageError.message).to.contain('exceeded 1 pages');

    const itemLimited = await clientReturning([{ records: [{ Id: 'a' }, { Id: 'b' }] }]);
    const itemError = await captureError(itemLimited.client.requestAll({ path: '/query' }, 200, { maxItems: 1 }));
    expect(itemError.message).to.contain('exceeded 1 items');
  });

  it('yields pages for incremental export writers', async () => {
    const { client } = await clientReturning([
      { records: [{ Id: 'a' }], nextRecordsUrl: '/services/data/v67.0/query/next' },
      { records: [{ Id: 'b' }] },
    ]);
    const pages: string[][] = [];
    for await (const page of client.requestPages<{ Id: string }>({ path: '/query' })) {
      pages.push(page.map((row) => row.Id));
    }
    expect(pages).to.deep.equal([['a'], ['b']]);
  });
});
