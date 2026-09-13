import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Org } from '@salesforce/core';
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { McnClient, PaginationLimits } from '../../../../../src/client/mcnClient.js';
import SegmentMembersExport, {
  exportSegmentMembers,
} from '../../../../../src/commands/mcnext/segment/members/export.js';
import { resolveSegmentApiName } from '../../../../../src/segment/segmentMembers.js';

type RequestOptions = Parameters<McnClient['requestAll']>[0];
type PageOptions = Parameters<McnClient['requestPages']>[0];

type FakeClientOptions = {
  segments: Array<Record<string, unknown>>;
  pages?: Array<Array<Record<string, unknown>>>;
  pageRequests?: PageOptions[];
};

function clientWith(options: FakeClientOptions): McnClient {
  return {
    request: async (request: RequestOptions) => {
      const apiName = decodeURIComponent(request.path.split('/').at(-1) ?? '');
      const segment = options.segments.find((candidate) => candidate.apiName === apiName);
      if (segment) return segment;
      throw Object.assign(new Error(`Segment not found: ${apiName}`), { name: 'ITEM_NOT_FOUND' });
    },
    requestAll: async (request: RequestOptions) => {
      expect(request).to.include({ path: '/ssot/segments', itemsKey: 'segments', pageSizeParam: 'batchSize' });
      return options.segments;
    },
    async *requestPages(request: PageOptions) {
      options.pageRequests?.push(request);
      for (const page of options.pages ?? []) yield page;
    },
  } as McnClient;
}

describe('mcnext segment members export', () => {
  const $$ = new TestContext();
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcnext-segment-members-'));
  });

  afterEach(async () => {
    $$.restore();
    await rm(directory, { recursive: true, force: true });
  });

  it('omits unset pagination limits so McnClient defaults remain active', async () => {
    const command = Object.create(SegmentMembersExport.prototype) as SegmentMembersExport;
    const requestPages = $$.SANDBOX.stub().returns(
      (async function* (): AsyncGenerator<never[]> {
        yield [];
      })()
    );
    const client = {
      request: async () => ({ apiName: 'Annual_Promo' }),
      requestPages,
    } as unknown as McnClient;
    $$.SANDBOX.stub(McnClient, 'create').resolves(client);
    $$.SANDBOX.stub(Org, 'create').resolves({} as Org);

    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'test@example.com',
          segment: 'Annual_Promo',
          'output-file': join(directory, 'members.json'),
          'result-format': 'json',
          limit: 200,
          offset: 0,
        },
      }),
    });

    await command.run();

    expect(requestPages.calledOnce).to.equal(true);
    expect(requestPages.firstCall.args[2] as PaginationLimits).to.deep.equal({});
  });

  for (const flagName of ['max-pages', 'max-items', 'max-duration-ms'] as const) {
    it(`rejects zero for --${flagName}`, async () => {
      const flag = SegmentMembersExport.flags[flagName];
      let caught: Error | undefined;

      try {
        await flag.parse('0', {} as never, flag);
      } catch (error) {
        caught = error as Error;
      }

      expect(caught?.message).to.contain('greater than or equal to 1');
    });
  }

  it('resolves API name, MarketSegment ID, and exact display name', async () => {
    const client = clientWith({
      segments: [
        {
          apiName: 'Annual_Promo',
          displayName: 'Annual Promo',
          marketSegmentId: '1sg000000000001',
        },
      ],
    });

    expect(await resolveSegmentApiName(client, 'Annual_Promo')).to.equal('Annual_Promo');
    expect(await resolveSegmentApiName(client, '1sg000000000001')).to.equal('Annual_Promo');
    expect(await resolveSegmentApiName(client, 'Annual Promo')).to.equal('Annual_Promo');
  });

  it('rejects missing and ambiguous segment selections', async () => {
    const client = clientWith({
      segments: [
        { apiName: 'First', displayName: 'Duplicate' },
        { apiName: 'Second', displayName: 'Duplicate' },
      ],
    });

    let missing: Error | undefined;
    try {
      await resolveSegmentApiName(client, 'Missing');
    } catch (error) {
      missing = error as Error;
    }
    expect(missing?.name).to.equal('ITEM_NOT_FOUND');
    expect(missing?.message).to.contain('Segment not found: Missing');

    let ambiguous: Error | undefined;
    try {
      await resolveSegmentApiName(client, 'Duplicate');
    } catch (error) {
      ambiguous = error as Error;
    }
    expect(ambiguous?.message).to.contain('ambiguous');
  });

  it('writes member pages to JSON and passes verified request options', async () => {
    const pageRequests: PageOptions[] = [];
    const outputFile = join(directory, 'nested', 'members.json');
    const client = clientWith({
      segments: [{ apiName: 'Annual_Promo', displayName: 'Annual Promo' }],
      pages: [[{ id: 'opaque-1', deltaType: 'new' }], [{ id: 'opaque-2', snapshotType: 'F' }]],
      pageRequests,
    });

    const result = await exportSegmentMembers({
      client,
      segment: 'Annual Promo',
      outputFile,
      resultFormat: 'json',
      fields: 'Id__c,Delta_Type__c',
      filters: "Delta_Type__c in ('new')",
      orderBy: 'Id__c asc',
      limit: 25,
      offset: 10,
      paginationLimits: { maxPages: 10, maxItems: 100, maxDurationMs: 1000 },
    });

    expect(JSON.parse(await readFile(outputFile, 'utf8'))).to.deep.equal([
      { id: 'opaque-1', deltaType: 'new' },
      { id: 'opaque-2', snapshotType: 'F' },
    ]);
    expect(pageRequests[0]).to.deep.equal({
      path: '/ssot/segments/Annual_Promo/members',
      itemsKey: 'data',
      pageSizeParam: 'limit',
      query: {
        fields: 'Id__c,Delta_Type__c',
        filters: "Delta_Type__c in ('new')",
        orderBy: 'Id__c asc',
        limit: 25,
        offset: 10,
      },
    });
    expect(result).to.deep.equal({
      segmentApiName: 'Annual_Promo',
      outputFile,
      resultFormat: 'json',
      rowsWritten: 2,
      complete: true,
    });
  });

  it('writes CSV using stable first-row columns and configured formatting', async () => {
    const outputFile = join(directory, 'members.csv');
    const client = clientWith({
      segments: [{ apiName: 'Annual_Promo' }],
      pages: [
        [
          { id: 'opaque|1', deltaType: 'new' },
          { id: 'opaque-2', deltaType: 'existing', ignored: true },
        ],
      ],
    });

    await exportSegmentMembers({
      client,
      segment: 'Annual_Promo',
      outputFile,
      resultFormat: 'csv',
      limit: 200,
      offset: 0,
      columnDelimiter: 'PIPE',
      lineEnding: 'CRLF',
      paginationLimits: {},
    });

    expect(await readFile(outputFile, 'utf8')).to.equal('id|deltaType\r\n"opaque|1"|new\r\nopaque-2|existing\r\n');
  });

  it('reports a partially written file as incomplete when paging fails', async () => {
    const outputFile = join(directory, 'members.json');
    const client = {
      request: async () => ({ apiName: 'Annual_Promo' }),
      async *requestPages() {
        yield [{ id: 'opaque-1' }];
        throw new Error('page failed');
      },
    } as unknown as McnClient;

    let caught: Error | undefined;
    try {
      await exportSegmentMembers({
        client,
        segment: 'Annual_Promo',
        outputFile,
        resultFormat: 'json',
        limit: 200,
        offset: 0,
        paginationLimits: {},
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).to.contain('stopped after 1 row(s)');
    expect(caught?.message).to.contain('is incomplete');
    expect(await readFile(outputFile, 'utf8')).to.equal('[\n  {"id":"opaque-1"}');
  });
});
