import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected promise to reject');
}

function clientWith(options: FakeClientOptions): McnClient {
  return {
    request: async (request: RequestOptions) => {
      const apiName = decodeURIComponent(request.path.split('/').at(-1) ?? '');
      const segment = options.segments.find((candidate) => candidate.apiName === apiName);
      if (segment) return { segments: [segment] };
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
      request: async () => ({ segments: [{ apiName: 'Annual_Promo' }] }),
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

  it('keeps basic ID/display-name resolution independent of the detail endpoint', async () => {
    for (const selection of ['1sg000000000001AAA', 'Annual Promo']) {
      /* eslint-disable no-await-in-loop -- each selection verifies an independent filesystem transaction */
      const outputFile = join(directory, `${selection.startsWith('1sg') ? 'id' : 'name'}.json`);
      const requests: string[] = [];
      const client = {
        request: async (request: RequestOptions) => {
          requests.push(request.path);
          if (request.path === `/ssot/segments/${encodeURIComponent(selection)}`) {
            throw Object.assign(new Error('direct selection not found'), { name: 'ITEM_NOT_FOUND' });
          }
          throw new Error('segment detail request must not occur after a list match');
        },
        requestAll: async () => [
          {
            apiName: 'Annual_Promo',
            displayName: 'Annual Promo',
            marketSegmentId: '1sg000000000001AAA',
          },
        ],
        async *requestPages() {
          yield [{ id: 'opaque-1' }];
        },
      } as unknown as McnClient;

      await exportSegmentMembers({
        client,
        segment: selection,
        outputFile,
        resultFormat: 'json',
        limit: 200,
        offset: 0,
        paginationLimits: {},
      });

      expect(JSON.parse(await readFile(outputFile, 'utf8'))).to.deep.equal([{ id: 'opaque-1' }]);
      expect(requests).to.deep.equal([`/ssot/segments/${encodeURIComponent(selection)}`]);
      /* eslint-enable no-await-in-loop */
    }
  });

  it('writes member pages to JSON and passes verified request options', async () => {
    const pageRequests: PageOptions[] = [];
    const outputFile = join(directory, 'nested', 'members.json');
    const client = clientWith({
      segments: [{ apiName: 'Annual_Promo', displayName: 'Annual Promo', marketSegmentId: '1sg000000000001AAA' }],
      pages: [[{ id: 'opaque-1', deltaType: 'new' }], [{ id: 'opaque-2', snapshotType: 'F' }]],
      pageRequests,
    });

    const result = await exportSegmentMembers({
      client,
      segment: '1sg000000000001AAA',
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
      includeDetails: false,
      dataSpace: 'default',
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

  it('preserves an existing destination and removes staging when paging fails', async () => {
    const outputFile = join(directory, 'members.json');
    await writeFile(outputFile, Buffer.from([0, 255, 10, 13, 7]));
    const client = {
      request: async () => ({ segments: [{ apiName: 'Annual_Promo' }] }),
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

    expect(caught?.message).to.contain('page failed');
    expect(await readFile(outputFile)).to.deep.equal(Buffer.from([0, 255, 10, 13, 7]));
    expect(await readdir(directory)).to.deep.equal(['members.json']);
  });

  for (const resultFormat of ['csv', 'json'] as const) {
    it(`exports enriched ${resultFormat.toUpperCase()} with 19 ordered columns and data-space provenance`, async () => {
      const columns = Array.from({ length: 19 }, (_, index) => ({
        name: index === 0 ? 'ssot__Id__c' : `Field${String(index).padStart(2, '0')}__c`,
        displayName: `Field ${index}`,
        ...(index === 0 ? { keyQualifier: 'Individual' } : {}),
      }));
      const requests: RequestOptions[] = [];
      const client = {
        request: async (request: RequestOptions) => {
          requests.push(request);
          if (request.path === '/ssot/segments/Annual_Promo') {
            return {
              segments: [
                {
                  apiName: 'Annual_Promo',
                  segmentMembershipDmo: { latestTable: 'Individual_Unified_SM_1__dlm' },
                  segmentOnApiName: 'UnifiedssotIndividualMkt__dlm',
                },
              ],
            };
          }
          if (request.path === '/query') {
            return { records: [{ Id: '0vh000000000001AAA', Name: 'Marketing' }], totalSize: 1, done: true };
          }
          if (request.path === '/ssot/metadata') {
            return {
              metadata: [
                {
                  name: 'Individual_Unified_SM_1__dlm',
                  fields: [{ name: 'Id__c' }, { name: 'Individual_Id__c', keyQualifier: 'Membership' }],
                  primaryKeys: ['Id__c'],
                  relationships: [
                    {
                      fromEntity: 'Individual_Unified_SM_1__dlm',
                      toEntity: 'UnifiedssotIndividualMkt__dlm',
                      fromField: 'Individual_Id__c',
                      toField: 'ssot__Id__c',
                      fromKeyQualifier: 'Membership',
                      toKeyQualifier: 'Individual',
                      cardinality: 'many-to-one',
                    },
                  ],
                },
                {
                  name: 'UnifiedssotIndividualMkt__dlm',
                  fields: columns,
                  primaryKeys: ['ssot__Id__c'],
                  relationships: [],
                },
              ],
            };
          }
          return {
            queryId: 'query-1',
            metadata: [
              ...columns.map((column) => ({ name: column.name })),
              { name: 'membership_key_internal' },
              { name: 'detail_match_count_internal' },
            ],
            data: [[...columns.map((_, index) => (index === 1 ? null : `value-${index}`)), 'membership-1', 1]],
            totalSize: 1,
          };
        },
      } as unknown as McnClient;
      const outputFile = join(directory, `details.${resultFormat}`);
      const result = await exportSegmentMembers({
        client,
        segment: 'Annual_Promo',
        outputFile,
        resultFormat,
        includeDetails: true,
        dataSpace: 'Marketing',
        limit: 200,
        offset: 0,
        paginationLimits: {},
      });

      const names = columns.map((column) => column.name);
      if (resultFormat === 'json') {
        const data = JSON.parse(await readFile(outputFile, 'utf8')) as Array<Record<string, unknown>>;
        expect(Object.keys(data[0])).to.deep.equal(names);
        expect(data[0][names[1]]).to.equal(null);
      } else {
        expect((await readFile(outputFile, 'utf8')).split('\n')[0].split(',')).to.deep.equal(names);
      }
      expect(
        requests
          .map((request) => request.headers?.['Data-Space'])
          .filter((header): header is string => header !== undefined)
      ).to.deep.equal(['Marketing', 'Marketing']);
      expect(result).to.include({ includeDetails: true, dataSpace: 'Marketing', rowsWritten: 1 });
      expect(result.enriched?.objectApiName).to.equal('UnifiedssotIndividualMkt__dlm');
      expect(result.enriched?.columns.map((column) => column.name)).to.deep.equal(names);
    });
  }

  it('rejects an unavailable data space before metadata/query and preserves the destination byte-for-byte', async () => {
    const outputFile = join(directory, 'invalid-space.json');
    const sentinel = Buffer.from([0, 255, 10, 13, 7]);
    await writeFile(outputFile, sentinel);
    const requests: string[] = [];
    const client = {
      request: async (request: RequestOptions) => {
        requests.push(request.path);
        if (request.path === '/ssot/segments/Annual_Promo') {
          return {
            segments: [
              {
                apiName: 'Annual_Promo',
                segmentMembershipDmo: { latestTable: 'Individual_Unified_SM_1__dlm' },
                segmentOnApiName: 'UnifiedssotIndividualMkt__dlm',
              },
            ],
          };
        }
        if (request.path === '/query') return { records: [], totalSize: 0, done: true };
        throw new Error(`Unexpected request: ${request.path}`);
      },
    } as unknown as McnClient;

    const error = await captureError(
      exportSegmentMembers({
        client,
        segment: 'Annual_Promo',
        outputFile,
        resultFormat: 'json',
        includeDetails: true,
        dataSpace: 'missing',
        limit: 10,
        paginationLimits: { maxItems: 10 },
      })
    );

    expect(error.name).to.equal('InvalidDataSpace');
    expect(requests).to.deep.equal(['/ssot/segments/Annual_Promo', '/query']);
    expect(await readFile(outputFile)).to.deep.equal(sentinel);
    expect(await readdir(directory)).to.deep.equal(['invalid-space.json']);
  });

  it('preserves the destination when enriched Query API rows have a nonterminal status without a query ID', async () => {
    const outputFile = join(directory, 'details.json');
    await writeFile(outputFile, 'original');
    const columns = Array.from({ length: 19 }, (_, index) => ({
      name: index === 0 ? 'ssot__Id__c' : `Field${String(index).padStart(2, '0')}__c`,
      ...(index === 0 ? { keyQualifier: 'Individual' } : {}),
    }));
    const client = {
      request: async (request: RequestOptions) => {
        if (request.path === '/ssot/segments/Annual_Promo') {
          return {
            segments: [
              {
                apiName: 'Annual_Promo',
                segmentMembershipDmo: { latestTable: 'Individual_Unified_SM_1__dlm' },
                segmentOnApiName: 'UnifiedssotIndividualMkt__dlm',
              },
            ],
          };
        }
        if (request.path === '/query') {
          return { records: [{ Id: '0vh000000000001AAA', Name: 'default' }], totalSize: 1, done: true };
        }
        if (request.path === '/ssot/metadata') {
          return {
            metadata: [
              {
                name: 'Individual_Unified_SM_1__dlm',
                fields: [{ name: 'Id__c' }, { name: 'Individual_Id__c', keyQualifier: 'Membership' }],
                primaryKeys: ['Id__c'],
                relationships: [
                  {
                    fromEntity: 'Individual_Unified_SM_1__dlm',
                    toEntity: 'UnifiedssotIndividualMkt__dlm',
                    fromField: 'Individual_Id__c',
                    toField: 'ssot__Id__c',
                    fromKeyQualifier: 'Membership',
                    toKeyQualifier: 'Individual',
                    cardinality: 'many-to-one',
                  },
                ],
              },
              {
                name: 'UnifiedssotIndividualMkt__dlm',
                fields: columns,
                primaryKeys: ['ssot__Id__c'],
                relationships: [],
              },
            ],
          };
        }
        return {
          status: 'RUNNING',
          metadata: [
            ...columns.map((column) => ({ name: column.name })),
            { name: 'membership_key_internal' },
            { name: 'detail_match_count_internal' },
          ],
          data: [[...columns.map(() => 'value'), 'membership-1', 1]],
          totalSize: 1,
        };
      },
    } as unknown as McnClient;

    let caught: Error | undefined;
    try {
      await exportSegmentMembers({
        client,
        segment: 'Annual_Promo',
        outputFile,
        resultFormat: 'json',
        includeDetails: true,
        dataSpace: 'default',
        limit: 200,
        offset: 0,
        paginationLimits: {},
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.name).to.equal('InvalidData360QueryEnvelope');
    expect(await readFile(outputFile, 'utf8')).to.equal('original');
    expect(await readdir(directory)).to.deep.equal(['details.json']);
  });

  it('rejects basic-only request flags in enriched mode before resolving the segment', async () => {
    for (const option of [{ fields: 'Id__c' }, { filters: "Id__c = '1'" }, { orderBy: 'Id__c asc' }, { offset: 1 }]) {
      /* eslint-disable no-await-in-loop -- each option independently verifies fail-fast validation */
      let requested = false;
      const client = {
        request: async () => {
          requested = true;
          throw new Error('must not request');
        },
      } as unknown as McnClient;
      let caught: Error | undefined;
      try {
        await exportSegmentMembers({
          client,
          segment: 'Annual_Promo',
          outputFile: join(directory, 'details.json'),
          resultFormat: 'json',
          includeDetails: true,
          dataSpace: 'default',
          limit: 200,
          paginationLimits: {},
          ...option,
        });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught?.name).to.equal('EnrichedModeBasicFlagError');
      expect(caught?.message).to.contain(
        Object.keys(option)[0] === 'orderBy' ? '--order-by' : `--${Object.keys(option)[0]}`
      );
      expect(requested).to.equal(false);
      /* eslint-enable no-await-in-loop */
    }
  });

  it('preserves the destination when the resolved detail envelope is malformed', async () => {
    const outputFile = join(directory, 'details.json');
    await writeFile(outputFile, 'original');
    const client = clientWith({ segments: [{ apiName: 'Annual_Promo', segmentMembershipDmo: {} }] });
    let caught: Error | undefined;
    try {
      await exportSegmentMembers({
        client,
        segment: 'Annual_Promo',
        outputFile,
        resultFormat: 'json',
        includeDetails: true,
        dataSpace: 'default',
        limit: 200,
        offset: 0,
        paginationLimits: {},
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.name).to.equal('InvalidSegmentMemberDetailSource');
    expect(await readFile(outputFile, 'utf8')).to.equal('original');
    expect(await readdir(directory)).to.deep.equal(['details.json']);
  });
});
