import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Org } from '@salesforce/core';
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { parse } from 'csv-parse/sync';
import { Org as FlagOrg } from '../../../../../node_modules/@salesforce/sf-plugins-core/node_modules/@salesforce/core/lib/org/org.js';
import { McnClient, PaginationLimits } from '../../../../../src/client/mcnClient.js';
import SegmentMembersExport, {
  exportSegmentMembers,
  normalizeFieldValue,
  resolveColumnHeaders,
  sanitizeDataSpaceDirectory,
  sanitizeFilename,
} from '../../../../../src/commands/mcnext/segment/members/export.js';
import { resolveSegmentApiName } from '../../../../../src/segment/segmentMembers.js';

import {
  createRunOwnedTemp,
  createRunOwnedDirectory,
  removeRunOwnedPath,
  removeRunOwnedRoot,
  type RunOwnedTemp,
} from '../../../../../src/filesystem/runOwnedTemp.js';

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
  let run: RunOwnedTemp;
  let directory: string;
  let siblingSentinel: string;
  const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  beforeEach(async () => {
    run = await createRunOwnedTemp('mcnext-segment-members');
    directory = await createRunOwnedDirectory(run, 'fixture');
    siblingSentinel = join(run.root, 'sibling-sentinel.txt');
    await writeFile(siblingSentinel, 'keep', 'utf8');
  });

  afterEach(async () => {
    if (stdinTtyDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinTtyDescriptor);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    $$.restore();
    await removeRunOwnedPath(run, directory);
    const childError = await stat(directory).catch((error: NodeJS.ErrnoException) => error);
    expect(childError).to.have.property('code', 'ENOENT');
    expect(await readFile(siblingSentinel, 'utf8')).to.equal('keep');
    await unlink(siblingSentinel);
    await removeRunOwnedRoot(run);
    const rootError = await stat(run.root).catch((error: NodeJS.ErrnoException) => error);
    expect(rootError).to.have.property('code', 'ENOENT');
  });

  it('allocates stable unique labels and preserves API-name order', () => {
    const columns = [
      { name: 'First__c', label: 'Name' },
      { name: 'Second__c', label: 'Name' },
      { name: 'Third__c', label: 'Name_2' },
      { name: 'Fourth__c', label: '   ' },
    ];
    expect(resolveColumnHeaders(columns, 'label')).to.deep.equal(['Name', 'Name_2', 'Name_2_2', 'Fourth__c']);
    expect(resolveColumnHeaders(columns, 'api-name')).to.deep.equal(columns.map((column) => column.name));
  });

  it('formats DATE and DATETIME values without timezone loss and preserves nulls', () => {
    expect(normalizeFieldValue('1982-12-16T00:00:00+00:00', 'DATE')).to.equal('1982-12-16');
    expect(normalizeFieldValue('2026-10-01T13:15:16.123+02:00', 'DateTime')).to.equal('2026-10-01 13:15:16.123+02:00');
    expect(normalizeFieldValue(null, 'DATE')).to.equal(null);
    expect(normalizeFieldValue('not-a-date', 'DATE')).to.equal('not-a-date');
  });

  it('sanitizes Windows-invalid, reserved, and empty filename components', () => {
    expect(sanitizeFilename('Annual: Promo / West?')).to.equal('Annual-Promo-West');
    expect(sanitizeFilename('CON')).to.equal('segment-CON');
    expect(sanitizeFilename('   ... ')).to.equal('segment-members');
  });

  it('does not silently default the data-space flag to default', () => {
    expect(SegmentMembersExport.flags['data-space'].default).to.equal(undefined);
  });

  it('sanitizes data-space directory names and rejects empty or path-like values', () => {
    expect(sanitizeDataSpaceDirectory('Eurex')).to.equal('Eurex');
    expect(sanitizeDataSpaceDirectory('My Space')).to.equal('My-Space');
    expect(sanitizeDataSpaceDirectory('CON')).to.equal('dataspace-CON');
    expect(() => sanitizeDataSpaceDirectory(undefined)).to.throw('resolved data space');
    expect(() => sanitizeDataSpaceDirectory('')).to.throw('resolved data space');
    expect(() => sanitizeDataSpaceDirectory('..')).to.throw('cannot be used');
    expect(() => sanitizeDataSpaceDirectory('a/b')).to.throw('cannot be used');
    expect(() => sanitizeDataSpaceDirectory('a\\b')).to.throw('cannot be used');
    expect(() => sanitizeDataSpaceDirectory('foo..bar')).to.throw('cannot be used');
  });

  it('resolves an explicit target org through the standard Salesforce CLI org flag', async () => {
    const expected = {} as FlagOrg;
    const create = $$.SANDBOX.stub(FlagOrg, 'create').resolves(expected);
    const flag = SegmentMembersExport.flags['target-org'];

    const resolved = await flag.parse('test@example.com', {} as never, flag);

    expect(resolved).to.equal(expected);
    expect(create.calledOnceWithExactly({ aliasOrUsername: 'test@example.com' })).to.equal(true);
  });

  it('resolves the standard Salesforce CLI default org when target-org is omitted', async () => {
    const expected = {} as FlagOrg;
    const create = $$.SANDBOX.stub(FlagOrg, 'create').resolves(expected);
    const flag = SegmentMembersExport.flags['target-org'];

    const resolveDefault = flag.default as unknown as (context: never) => Promise<FlagOrg>;
    const resolved = await resolveDefault({} as never);

    expect(resolved).to.equal(expected);
    expect(create.calledOnceWithExactly({ aliasOrUsername: undefined })).to.equal(true);
  });

  it('returns the standard useful failure when neither target-org nor a default org exists', async () => {
    $$.SANDBOX.stub(FlagOrg, 'create').rejects(new Error('No authorization information found'));
    const flag = SegmentMembersExport.flags['target-org'];

    const resolveDefault = flag.default as unknown as (context: never) => Promise<FlagOrg>;
    const error = await captureError(resolveDefault({} as never));

    expect(error.name).to.equal('NoDefaultEnvError');
    expect(error.message).to.contain('No default environment found');
    expect(error.message).to.contain('--target-org');
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
    const org = { getUsername: () => 'test@example.com' } as Org;

    Object.assign(command, {
      logToStderr: $$.SANDBOX.stub(),
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': org,
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

  for (const [tty, json, shouldPrompt] of [
    [true, false, true],
    [false, false, false],
    [true, true, false],
    [false, true, false],
  ]) {
    it(`gates command picker with TTY=${tty} and json=${json}`, async () => {
      const command = Object.create(SegmentMembersExport.prototype) as SegmentMembersExport;
      const segments = ['Eurex', 'OtherBu'].map((dataSpace, index) => ({
        apiName: `Segment_${index}`,
        displayName: 'Shared Name',
        marketSegmentId: `1sg00000000000${index + 1}`,
        dataSpace,
      }));
      const client = clientWith({ segments, pages: [[{ id: 'one' }]] });
      const picker = $$.SANDBOX.stub().resolves(segments[1]);
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: tty });
      $$.SANDBOX.stub(McnClient, 'create').resolves(client);
      const org = { getUsername: () => 'test@example.com' } as Org;
      $$.SANDBOX.stub(Org, 'create').resolves(org);
      Object.assign(command, {
        selectSegment: picker,
        jsonEnabled: () => json,
        logToStderr: $$.SANDBOX.stub(),
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'target-org': org,
            segment: 'Shared Name',
            'output-file': join(directory, 'picked.json'),
            'result-format': 'json',
            limit: 200,
          },
        }),
      });
      if (shouldPrompt) {
        const result = await command.run();
        expect(result.segmentApiName).to.equal('Segment_1');
        expect(picker.calledOnceWithExactly(segments)).to.equal(true);
        expect(JSON.parse(await readFile(result.outputFile, 'utf8'))).to.deep.equal([{ id: 'one' }]);
      } else {
        const error = await captureError(command.run());
        expect(error.name).to.equal('AmbiguousSegmentError');
        expect(error.message).to.include('Eurex').and.include('OtherBu');
        expect(error.message).to.include(segments[0].marketSegmentId).and.include(segments[1].marketSegmentId);
        expect(picker.called).to.equal(false);
        expect(await readdir(directory)).to.deep.equal([]);
      }
    });
  }

  it('reports resolved, known and unknown batch progress plus final confirmation on stderr', async () => {
    const command = Object.create(SegmentMembersExport.prototype) as SegmentMembersExport;
    const logToStderr = $$.SANDBOX.stub();
    const client = {
      request: async () => ({ segments: [{ apiName: 'Annual_Promo' }] }),
      async *requestPages(
        _request: PageOptions,
        _pageSize: number,
        _limits: PaginationLimits,
        onProgress?: (progress: { batch: number; expectedBatches?: number; rows: number }) => void
      ) {
        onProgress?.({ batch: 1, expectedBatches: 2, rows: 1 });
        yield [{ id: 'one' }];
        onProgress?.({ batch: 2, expectedBatches: 2, rows: 2 });
        yield [{ id: 'two' }];
      },
    } as unknown as McnClient;
    $$.SANDBOX.stub(McnClient, 'create').resolves(client);
    const org = { getUsername: () => 'test@example.com' } as Org;
    Object.assign(command, {
      logToStderr,
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': org,
          segment: 'Annual_Promo',
          'output-file': join(directory, 'progress.json'),
          'result-format': 'json',
          'column-headers': 'label',
          limit: 200,
          offset: 0,
        },
      }),
    });

    const result = await command.run();

    expect(result.rowsWritten).to.equal(2);
    expect(logToStderr.args.map((args: unknown[]) => args[0])).to.deep.equal([
      'Found segment Annual_Promo. Starting download.',
      'Downloading batch 1 of 2',
      'Downloading batch 2 of 2',
      `Saved 2 segment members to ${join(directory, 'progress.json')}`,
    ]);
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
        {
          apiName: 'First',
          displayName: 'Duplicate',
          dataSpace: 'Eurex',
          marketSegmentId: '1sg000000000001',
        },
        {
          apiName: 'Second',
          displayName: 'Duplicate',
          dataSpace: 'OtherBu',
          marketSegmentId: '1sg000000000002',
        },
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
    expect(ambiguous?.name).to.equal('AmbiguousSegmentError');
    expect(ambiguous?.message).to.contain('ambiguous');
    expect(ambiguous?.message).to.contain('1sg000000000001');
    expect(ambiguous?.message).to.contain('data space Eurex');
    expect(ambiguous?.message).not.to.contain('Use its API name');
  });

  it('selects one ambiguous display name when --data-space is provided', async () => {
    const client = clientWith({
      segments: [
        {
          apiName: 'First',
          displayName: 'Duplicate',
          dataSpace: 'Eurex',
          marketSegmentId: '1sg000000000001',
        },
        {
          apiName: 'Second',
          displayName: 'Duplicate',
          dataSpace: 'OtherBu',
          marketSegmentId: '1sg000000000002',
        },
      ],
    });

    expect(await resolveSegmentApiName(client, 'Duplicate', { dataSpace: 'Eurex' })).to.equal('First');
  });

  it('resolves basic ID/display-name selection through the list then a detail envelope', async () => {
    for (const selection of ['1sg000000000001AAA', 'Annual Promo']) {
      /* eslint-disable no-await-in-loop -- each selection verifies an independent filesystem transaction */
      const outputFile = join(directory, `${selection.startsWith('1sg') ? 'id' : 'name'}.json`);
      const requests: string[] = [];
      const segment = {
        apiName: 'Annual_Promo',
        displayName: 'Annual Promo',
        marketSegmentId: '1sg000000000001AAA',
        dataSpace: 'default',
      };
      const client = {
        request: async (request: RequestOptions) => {
          requests.push(request.path);
          if (request.path === `/ssot/segments/${encodeURIComponent(selection)}`) {
            throw Object.assign(new Error('direct selection not found'), { name: 'ITEM_NOT_FOUND' });
          }
          if (request.path === '/ssot/segments/Annual_Promo') return { segments: [segment] };
          throw new Error(`Unexpected request: ${request.path}`);
        },
        requestAll: async () => [segment],
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
      expect(requests).to.deep.equal([
        `/ssot/segments/${encodeURIComponent(selection)}`,
        '/ssot/segments/Annual_Promo',
      ]);
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
      dataSpace: '',
      rowsWritten: 2,
      columnHeaders: 'api-name',
      complete: true,
    });
  });

  it('generates an absolute sanitized collision-safe filename under ./data/<data-space>/ when output-file is omitted', async () => {
    const previousCwd = process.cwd();
    process.chdir(directory);
    try {
      const client = clientWith({
        segments: [{ apiName: 'Annual_Promo', displayName: 'Annual: Promo?', dataSpace: 'Eurex' }],
        pages: [[]],
      });
      const first = await exportSegmentMembers({
        client,
        segment: 'Annual: Promo?',
        resultFormat: 'json',
        limit: 200,
        paginationLimits: {},
      });
      const second = await exportSegmentMembers({
        client,
        segment: 'Annual: Promo?',
        resultFormat: 'json',
        limit: 200,
        paginationLimits: {},
      });

      expect(isAbsolute(first.outputFile)).to.equal(true);
      expect(first.outputFile).to.match(
        /[/\\]data[/\\]Eurex[/\\]Annual-Promo-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/u
      );
      expect(second.outputFile).to.match(/[/\\]data[/\\]Eurex[/\\].*_2\.json$/u);
      expect(second.outputFile).not.to.equal(first.outputFile);
      expect(await readdir(join(directory, 'data', 'Eurex'))).to.have.length(2);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('fails closed when generating a default path without a resolved data space', async () => {
    const previousCwd = process.cwd();
    process.chdir(directory);
    try {
      const client = clientWith({
        segments: [{ apiName: 'Annual_Promo', displayName: 'Annual Promo' }],
        pages: [[{ id: 'one' }]],
      });
      const error = await captureError(
        exportSegmentMembers({
          client,
          segment: 'Annual_Promo',
          resultFormat: 'json',
          limit: 200,
          paginationLimits: {},
        })
      );
      expect(error.name).to.equal('MissingDataSpace');
      expect(await readdir(directory)).to.deep.equal([]);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('writes a generated destination through sibling staging before atomic replacement', async () => {
    const previousCwd = process.cwd();
    process.chdir(directory);
    try {
      let filesDuringWrite: string[] = [];
      const outputDir = join(directory, 'data', 'default');
      const client = {
        request: async () => ({
          segments: [{ apiName: 'Annual_Promo', displayName: 'Annual Promo', dataSpace: 'default' }],
        }),
        async *requestPages() {
          filesDuringWrite = await readdir(outputDir);
          yield [{ id: 'opaque-1' }];
        },
      } as unknown as McnClient;

      const result = await exportSegmentMembers({
        client,
        segment: 'Annual_Promo',
        resultFormat: 'json',
        limit: 200,
        paginationLimits: {},
      });

      const destinationName = result.outputFile.split(/[\\/]/u).at(-1) as string;
      expect(result.outputFile).to.include(join('data', 'default'));
      expect(filesDuringWrite).to.include(destinationName);
      expect(
        filesDuringWrite.some((name) => name.startsWith(`.${destinationName}.`) && name.endsWith('.stage'))
      ).to.equal(true);
      expect(await readdir(outputDir)).to.deep.equal([destinationName]);
      expect(JSON.parse(await readFile(result.outputFile, 'utf8'))).to.deep.equal([{ id: 'opaque-1' }]);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('removes generated reservation and staging artifacts when atomic writing fails', async () => {
    const previousCwd = process.cwd();
    process.chdir(directory);
    try {
      let filesDuringWrite: string[] = [];
      const outputDir = join(directory, 'data', 'default');
      const client = {
        request: async () => ({
          segments: [{ apiName: 'Annual_Promo', displayName: 'Annual Promo', dataSpace: 'default' }],
        }),
        async *requestPages() {
          filesDuringWrite = await readdir(outputDir);
          yield [{ id: 'opaque-1' }];
          throw new Error('generated page failed');
        },
      } as unknown as McnClient;

      const error = await captureError(
        exportSegmentMembers({
          client,
          segment: 'Annual_Promo',
          resultFormat: 'json',
          limit: 200,
          paginationLimits: {},
        })
      );

      expect(error.message).to.contain('generated page failed');
      expect(filesDuringWrite.some((name) => name.endsWith('.json'))).to.equal(true);
      expect(filesDuringWrite.some((name) => name.endsWith('.stage'))).to.equal(true);
      expect(await readdir(outputDir)).to.deep.equal([]);
      expect(await readdir(directory)).to.deep.equal(['data']);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('removes a generated enriched destination when row streaming fails', async () => {
    const previousCwd = process.cwd();
    process.chdir(directory);
    try {
      const columns = Array.from({ length: 19 }, (_, index) => ({
        name: index === 0 ? 'ssot__Id__c' : `Field${String(index).padStart(2, '0')}__c`,
        displayName: `Field ${index}`,
        ...(index === 0 ? { keyQualifier: 'Individual' } : {}),
      }));
      const client = {
        request: async (request: RequestOptions) => {
          if (request.path === '/ssot/segments/Annual_Promo')
            return {
              segments: [
                {
                  apiName: 'Annual_Promo',
                  displayName: 'Annual Promo',
                  dataSpace: 'default',
                  marketSegmentId: '1sgaj000000PveDAAG',
                  segmentMembershipDmo: { latestTable: 'Individual_Unified_SM_1__dlm' },
                  segmentOnApiName: 'UnifiedssotIndividualMkt__dlm',
                },
              ],
            };
          if (request.path === '/query')
            return { records: [{ Id: '0vh000000000001AAA', DataSpaceApiName: 'default' }], totalSize: 1, done: true };
          if (request.path === '/ssot/metadata')
            return {
              metadata: [
                {
                  name: 'Individual_Unified_SM_1__dlm',
                  fields: [
                    { name: 'Id__c' },
                    { name: 'Individual_Id__c', keyQualifier: 'Membership' },
                    { name: 'Segment_Id__c', type: 'TEXT' },
                  ],
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
      await captureError(
        exportSegmentMembers({
          client,
          segment: 'Annual_Promo',
          resultFormat: 'json',
          includeDetails: true,
          dataSpace: 'default',
          limit: 200,
          paginationLimits: {},
        })
      );
      expect(await readdir(join(directory, 'data', 'default'))).to.deep.equal([]);
      expect(await readdir(directory)).to.deep.equal(['data']);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('preserves explicit output-file compatibility while returning an absolute path', async () => {
    const previousCwd = process.cwd();
    process.chdir(directory);
    try {
      const client = clientWith({ segments: [{ apiName: 'Annual_Promo' }], pages: [[{ id: 'one' }]] });
      const result = await exportSegmentMembers({
        client,
        segment: 'Annual_Promo',
        outputFile: 'explicit.json',
        resultFormat: 'json',
        limit: 200,
        paginationLimits: {},
      });
      expect(result.outputFile).to.equal(join(directory, 'explicit.json'));
      expect(JSON.parse(await readFile(result.outputFile, 'utf8'))).to.deep.equal([{ id: 'one' }]);
    } finally {
      process.chdir(previousCwd);
    }
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
        displayName: index === 0 ? 'Member ID' : index === 1 ? 'Member ID' : index === 2 ? '' : `Field ${index}`,
        type: index === 3 ? 'DATE' : index === 4 ? 'DATETIME' : 'Text',
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
                  marketSegmentId: '1sgaj000000PveDAAG',
                  segmentMembershipDmo: { latestTable: 'Individual_Unified_SM_1__dlm' },
                  segmentOnApiName: 'UnifiedssotIndividualMkt__dlm',
                },
              ],
            };
          }
          if (request.path === '/query') {
            return { records: [{ Id: '0vh000000000001AAA', DataSpaceApiName: 'Marketing' }], totalSize: 1, done: true };
          }
          if (request.path === '/ssot/metadata') {
            return {
              metadata: [
                {
                  name: 'Individual_Unified_SM_1__dlm',
                  fields: [
                    { name: 'Id__c' },
                    { name: 'Individual_Id__c', keyQualifier: 'Membership' },
                    { name: 'Segment_Id__c', type: 'TEXT' },
                  ],
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
            data: [
              [
                ...columns.map((_, index) =>
                  index === 1
                    ? null
                    : index === 3
                    ? '1982-12-16T00:00:00+00:00'
                    : index === 4
                    ? '2026-10-01T13:15:16.123+02:00'
                    : `value-${index}`
                ),
                'membership-1',
                1,
              ],
            ],
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
      const labels = ['Member ID', 'Member ID_2', names[2], ...columns.slice(3).map((column) => column.displayName)];
      if (resultFormat === 'json') {
        const data = JSON.parse(await readFile(outputFile, 'utf8')) as Array<Record<string, unknown>>;
        expect(Object.keys(data[0])).to.deep.equal(labels);
        expect(data[0]['Member ID_2']).to.equal(null);
        expect(data[0][labels[3]]).to.equal('1982-12-16');
        expect(data[0][labels[4]]).to.equal('2026-10-01 13:15:16.123+02:00');
      } else {
        const lines = (await readFile(outputFile, 'utf8')).split('\n');
        expect(lines[0].split(',')).to.deep.equal(labels);
        expect(lines[1]).to.contain('1982-12-16');
        expect(lines[1]).to.contain('2026-10-01 13:15:16.123+02:00');
      }
      expect(
        requests
          .map((request) => request.headers?.['Data-Space'])
          .filter((header): header is string => header !== undefined)
      ).to.deep.equal(['Marketing', 'Marketing']);
      expect(result).to.include({
        includeDetails: true,
        dataSpace: 'Marketing',
        rowsWritten: 1,
        columnHeaders: 'label',
      });
      expect(result.enriched?.objectApiName).to.equal('UnifiedssotIndividualMkt__dlm');
      expect(result.enriched?.columns.map((column) => column.name)).to.deep.equal(names);
    });
  }

  it('excludes foreign segment rows when two descriptors share the latest membership DMO', async () => {
    const columns = Array.from({ length: 19 }, (_, index) => ({
      name: index === 0 ? 'ssot__Id__c' : `Field${index}__c`,
      type: 'TEXT',
    }));
    const descriptors = [
      { apiName: 'Selected', marketSegmentId: '1sgaj000000PveDAAG' },
      { apiName: 'Foreign', marketSegmentId: '1sgaj000000PveEAAG' },
    ].map((descriptor) => ({
      ...descriptor,
      segmentMembershipDmo: { latestTable: 'Shared_Membership__dlm' },
      segmentOnApiName: 'UnifiedssotIndividualMkt__dlm',
    }));
    const memberships = [
      { segmentId: '1sgaj000000PveD', value: 'selected-member' },
      { segmentId: '1sgaj000000PveE', value: 'foreign-member' },
    ];
    const sqlQueries: string[] = [];
    const client = {
      request: async (request: RequestOptions) => {
        const descriptor = descriptors.find((candidate) => request.path === `/ssot/segments/${candidate.apiName}`);
        if (descriptor) return { segments: [descriptor] };
        if (request.path === '/query')
          return { records: [{ Id: '0vh000000000001AAA', DataSpaceApiName: 'default' }], totalSize: 1, done: true };
        if (request.path === '/ssot/metadata')
          return {
            metadata: [
              {
                name: 'Shared_Membership__dlm',
                fields: [{ name: 'Id__c' }, { name: 'Segment_Id__c', type: 'TEXT' }],
                primaryKeys: ['Id__c'],
                relationships: [
                  {
                    fromEntity: 'Shared_Membership__dlm',
                    toEntity: 'UnifiedssotIndividualMkt__dlm',
                    fromField: 'Id__c',
                    toField: 'ssot__Id__c',
                    cardinality: 'NTOONE',
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
        const sql = (request.body as { sql: string }).sql;
        sqlQueries.push(sql);
        const filter = /WHERE m\."Segment_Id__c" = '([^']+)'/u.exec(sql)?.[1];
        const selected = memberships.filter((member) => filter === undefined || member.segmentId === filter);
        return {
          queryId: 'shared-query',
          metadata: [
            ...columns.map(({ name }) => ({ name })),
            { name: 'membership_key_internal' },
            { name: 'detail_match_count_internal' },
          ],
          data: selected.map((member) => [...columns.map(() => member.value), member.value, 1]),
          totalSize: selected.length,
        };
      },
    } as unknown as McnClient;
    for (const descriptor of descriptors) {
      const outputFile = join(directory, `${descriptor.apiName}.json`);
      // eslint-disable-next-line no-await-in-loop -- serial exports preserve query assertion order
      const result = await exportSegmentMembers({
        client,
        segment: descriptor.apiName,
        outputFile,
        resultFormat: 'json',
        includeDetails: true,
        dataSpace: 'default',
        limit: 200,
        paginationLimits: {},
      });
      expect(result.rowsWritten).to.equal(1);
      // eslint-disable-next-line no-await-in-loop -- inspect each completed export before the next request
      const text = await readFile(outputFile, 'utf8');
      expect(text).to.contain(descriptor.apiName === 'Selected' ? 'selected-member' : 'foreign-member');
      expect(text).not.to.contain(descriptor.apiName === 'Selected' ? 'foreign-member' : 'selected-member');
    }
    expect(sqlQueries[0]).to.contain('WHERE m."Segment_Id__c" = \'1sgaj000000PveD\'');
    expect(sqlQueries[1]).to.contain('WHERE m."Segment_Id__c" = \'1sgaj000000PveE\'');
  });

  for (const failLastPage of [false, true]) {
    it(
      failLastPage
        ? 'preserves the destination when enriched CSV paging fails after more than 1000 rows'
        : 'exports more than 1000 enriched CSV rows with 19 columns and exact continuation offsets',
      async () => {
        const columns = Array.from({ length: 19 }, (_, index) => ({
          name: index === 0 ? 'ssot__Id__c' : `Field${String(index).padStart(2, '0')}__c`,
          displayName: `Field ${index}`,
          type: 'Text',
          ...(index === 0 ? { keyQualifier: 'Individual' } : {}),
        }));
        const expectedRows = Array.from({ length: 1505 }, (_, row) =>
          columns.map((_field, column) =>
            column === 1 ? `Member ${row}, "quoted"\nsecond line` : `value-${row}-${column}`
          )
        );
        const metadata = [
          ...columns.map((column) => ({ name: column.name })),
          { name: 'membership_key_internal' },
          { name: 'detail_match_count_internal' },
        ];
        const requests: RequestOptions[] = [];
        const outputFile = join(directory, 'paged-details.csv');
        const sentinel = Buffer.from([0, 255, 10, 13, 7]);
        await writeFile(outputFile, sentinel);
        const client = {
          request: async (request: RequestOptions) => {
            requests.push(request);
            if (request.path === '/ssot/segments/Annual_Promo') {
              return {
                segments: [
                  {
                    apiName: 'Annual_Promo',
                    marketSegmentId: '1sgaj000000PveDAAG',
                    segmentMembershipDmo: { latestTable: 'Individual_Unified_SM_1__dlm' },
                    segmentOnApiName: 'UnifiedssotIndividualMkt__dlm',
                  },
                ],
              };
            }
            if (request.path === '/query') {
              return { records: [{ Id: '0vh000000000001AAA', DataSpaceApiName: 'default' }], totalSize: 1, done: true };
            }
            if (request.path === '/ssot/metadata') {
              return {
                metadata: [
                  {
                    name: 'Individual_Unified_SM_1__dlm',
                    fields: [
                      { name: 'Id__c' },
                      { name: 'Individual_Id__c', keyQualifier: 'Membership' },
                      { name: 'Segment_Id__c', type: 'TEXT' },
                    ],
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
            const isSubmission = request.path === '/ssot/query-sql';
            expect(request.path).to.equal(isSubmission ? '/ssot/query-sql' : '/ssot/query-sql/query-many/rows');
            expect(request.headers).to.deep.equal({ 'Data-Space': 'default' });
            if (isSubmission) expect(request.method).to.equal('POST');
            const offset = isSubmission ? 0 : Number(request.query?.offset);
            if (failLastPage && offset === 1500) {
              expect(await readFile(outputFile)).to.deep.equal(sentinel);
              expect((await readdir(directory)).some((name) => name.endsWith('.stage'))).to.equal(true);
              throw new Error('late enriched page failed');
            }
            return {
              queryId: 'query-many',
              metadata,
              data: expectedRows
                .slice(offset, offset + 500)
                .map((row, index) => [...row, `membership-${offset + index}`, 1]),
              offset,
              rowLimit: 500,
              totalSize: expectedRows.length,
            };
          },
        } as unknown as McnClient;
        const exporting = exportSegmentMembers({
          client,
          segment: 'Annual_Promo',
          outputFile,
          resultFormat: 'csv',
          includeDetails: true,
          dataSpace: 'default',
          limit: 500,
          paginationLimits: {},
        });

        if (failLastPage) {
          const error = await captureError(exporting);
          expect(error.message).to.contain('late enriched page failed');
          expect(await readFile(outputFile)).to.deep.equal(sentinel);
        } else {
          const result = await exporting;
          const records = parse(await readFile(outputFile, 'utf8'));
          const headers = columns.map((column) => column.displayName);
          expect(result).to.include({ rowsWritten: 1505, complete: true });
          expect(records).to.have.length(1506);
          expect(records[0]).to.deep.equal(headers);
          expect(records.filter((row) => row[0] === headers[0])).to.have.length(1);
          expect(records.every((row) => row.length === 19)).to.equal(true);
          expect(records.slice(1)).to.deep.equal(expectedRows);
        }
        expect(
          requests.filter((request) => request.path.endsWith('/rows')).map((request) => request.query)
        ).to.deep.equal([
          { offset: 500, rowLimit: 500 },
          { offset: 1000, rowLimit: 500 },
          { offset: 1500, rowLimit: 500 },
        ]);
        expect(await readdir(directory)).to.deep.equal(['paged-details.csv']);
      }
    );
  }

  it('uses API-name headers consistently for enriched CSV and JSON', async () => {
    const columns = Array.from({ length: 19 }, (_, index) => ({
      name: index === 0 ? 'ssot__Id__c' : `Field${String(index).padStart(2, '0')}__c`,
      displayName: 'Duplicate',
      type: 'Text',
      ...(index === 0 ? { keyQualifier: 'Individual' } : {}),
    }));
    for (const resultFormat of ['csv', 'json'] as const) {
      /* eslint-disable no-await-in-loop -- each format verifies an independent output transaction */
      const client = {
        request: async (request: RequestOptions) => {
          if (request.path === '/ssot/segments/Annual_Promo')
            return {
              segments: [
                {
                  apiName: 'Annual_Promo',
                  marketSegmentId: '1sgaj000000PveDAAG',
                  segmentMembershipDmo: { latestTable: 'Individual_Unified_SM_1__dlm' },
                  segmentOnApiName: 'UnifiedssotIndividualMkt__dlm',
                },
              ],
            };
          if (request.path === '/query')
            return { records: [{ Id: '0vh000000000001AAA', DataSpaceApiName: 'default' }], totalSize: 1, done: true };
          if (request.path === '/ssot/metadata')
            return {
              metadata: [
                {
                  name: 'Individual_Unified_SM_1__dlm',
                  fields: [
                    { name: 'Id__c' },
                    { name: 'Individual_Id__c', keyQualifier: 'Membership' },
                    { name: 'Segment_Id__c', type: 'TEXT' },
                  ],
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
          return {
            queryId: 'query-1',
            metadata: [
              ...columns.map((column) => ({ name: column.name })),
              { name: 'membership_key_internal' },
              { name: 'detail_match_count_internal' },
            ],
            data: [[...columns.map((_, index) => `value-${index}`), 'membership-1', 1]],
            totalSize: 1,
          };
        },
      } as unknown as McnClient;
      const outputFile = join(directory, `api-names.${resultFormat}`);
      await exportSegmentMembers({
        client,
        segment: 'Annual_Promo',
        outputFile,
        resultFormat,
        columnHeaders: 'api-name',
        includeDetails: true,
        dataSpace: 'default',
        limit: 200,
        paginationLimits: {},
      });
      const names = columns.map((column) => column.name);
      if (resultFormat === 'json') {
        const data = JSON.parse(await readFile(outputFile, 'utf8')) as Array<Record<string, unknown>>;
        expect(Object.keys(data[0])).to.deep.equal(names);
      } else expect((await readFile(outputFile, 'utf8')).split('\n')[0].split(',')).to.deep.equal(names);
      /* eslint-enable no-await-in-loop */
    }
  });

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
                marketSegmentId: '1sgaj000000PveDAAG',
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
                marketSegmentId: '1sgaj000000PveDAAG',
                segmentMembershipDmo: { latestTable: 'Individual_Unified_SM_1__dlm' },
                segmentOnApiName: 'UnifiedssotIndividualMkt__dlm',
              },
            ],
          };
        }
        if (request.path === '/query') {
          return { records: [{ Id: '0vh000000000001AAA', DataSpaceApiName: 'default' }], totalSize: 1, done: true };
        }
        if (request.path === '/ssot/metadata') {
          return {
            metadata: [
              {
                name: 'Individual_Unified_SM_1__dlm',
                fields: [
                  { name: 'Id__c' },
                  { name: 'Individual_Id__c', keyQualifier: 'Membership' },
                  { name: 'Segment_Id__c', type: 'TEXT' },
                ],
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

  for (const marketSegmentId of [undefined, '', '001aj000000PveD']) {
    it(`fails closed before querying when the resolved MarketSegment ID is ${String(marketSegmentId)}`, async () => {
      const outputFile = join(directory, 'invalid-id.json');
      await writeFile(outputFile, 'original');
      const requests: string[] = [];
      const client = {
        request: async (request: RequestOptions) => {
          requests.push(request.path);
          if (request.path === '/ssot/segments/Annual_Promo')
            return {
              segments: [
                {
                  apiName: 'Annual_Promo',
                  marketSegmentId,
                  segmentMembershipDmo: { latestTable: 'Shared_Membership__dlm' },
                  segmentOnApiName: 'UnifiedssotIndividualMkt__dlm',
                },
              ],
            };
          if (request.path === '/query')
            return { records: [{ Id: '0vh000000000001AAA', DataSpaceApiName: 'default' }], totalSize: 1, done: true };
          throw new Error('Must not query metadata or memberships without a valid identity');
        },
      } as unknown as McnClient;
      const error = await captureError(
        exportSegmentMembers({
          client,
          segment: 'Annual_Promo',
          outputFile,
          resultFormat: 'json',
          includeDetails: true,
          dataSpace: 'default',
          limit: 200,
          paginationLimits: {},
        })
      );
      expect(error.name).to.equal(
        marketSegmentId === undefined ? 'InvalidSegmentMemberDetailSource' : 'InvalidMarketSegmentId'
      );
      expect(requests).not.to.include('/ssot/query-sql');
      expect(requests).not.to.include('/ssot/metadata');
      expect(await readFile(outputFile, 'utf8')).to.equal('original');
    });
  }

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

  it('auto-resolves enriched data space from segment.dataSpace when the flag is omitted', async () => {
    const columns = [
      { name: 'ssot__Id__c', displayName: 'Id', type: 'Text', keyQualifier: 'Individual' },
      { name: 'Extra__c', displayName: 'Extra', type: 'Text' },
    ];
    const headers: string[] = [];
    const client = {
      request: async (request: RequestOptions) => {
        if (request.headers?.['Data-Space']) headers.push(request.headers['Data-Space']);
        if (request.path === '/ssot/segments/Annual_Promo') {
          return {
            segments: [
              {
                apiName: 'Annual_Promo',
                dataSpace: 'Eurex',
                marketSegmentId: '1sgaj000000PveDAAG',
                segmentMembershipDmo: { latestTable: 'Individual_Unified_SM_1__dlm' },
                segmentOnApiName: 'UnifiedIndividual__dlm',
              },
            ],
          };
        }
        if (request.path === '/query') {
          return { records: [{ Id: '0vh000000000001AAA', DataSpaceApiName: 'Eurex' }], totalSize: 1, done: true };
        }
        if (request.path === '/ssot/metadata') {
          return {
            metadata: [
              {
                name: 'Individual_Unified_SM_1__dlm',
                fields: [
                  { name: 'Id__c' },
                  { name: 'Individual_Id__c', keyQualifier: 'Membership' },
                  { name: 'Segment_Id__c', type: 'TEXT' },
                ],
                primaryKeys: ['Id__c'],
                relationships: [
                  {
                    fromEntity: 'Individual_Unified_SM_1__dlm',
                    toEntity: 'UnifiedIndividual__dlm',
                    fromField: 'Individual_Id__c',
                    toField: 'ssot__Id__c',
                    fromKeyQualifier: 'Membership',
                    toKeyQualifier: 'Individual',
                    cardinality: 'many-to-one',
                  },
                ],
              },
              {
                name: 'UnifiedIndividual__dlm',
                fields: columns,
                primaryKeys: ['ssot__Id__c'],
                relationships: [],
              },
            ],
          };
        }
        return {
          queryId: 'query-eurex',
          metadata: [
            ...columns.map((column) => ({ name: column.name })),
            { name: 'membership_key_internal' },
            { name: 'detail_match_count_internal' },
          ],
          data: [['individual-1', 'extra', 'membership-1', 1]],
          totalSize: 1,
        };
      },
    } as unknown as McnClient;
    const outputFile = join(directory, 'eurex-details.json');
    const result = await exportSegmentMembers({
      client,
      segment: 'Annual_Promo',
      outputFile,
      resultFormat: 'json',
      includeDetails: true,
      limit: 200,
      paginationLimits: {},
    });

    expect(result.dataSpace).to.equal('Eurex');
    expect(result.enriched?.objectApiName).to.equal('UnifiedIndividual__dlm');
    expect(result.enriched?.columns).to.have.length(2);
    expect(headers).to.deep.equal(['Eurex', 'Eurex']);
    expect(JSON.parse(await readFile(outputFile, 'utf8'))).to.deep.equal([{ Id: 'individual-1', Extra: 'extra' }]);
  });

  it('passes --data-space into basic export segment resolution', async () => {
    const pageRequests: PageOptions[] = [];
    const client = clientWith({
      segments: [
        {
          apiName: 'First',
          displayName: 'Shared Name',
          dataSpace: 'Eurex',
          marketSegmentId: '1sg000000000001',
        },
        {
          apiName: 'Second',
          displayName: 'Shared Name',
          dataSpace: 'OtherBu',
          marketSegmentId: '1sg000000000002',
        },
      ],
      pages: [[{ id: 'member-1' }]],
      pageRequests,
    });
    const outputFile = join(directory, 'basic-disambiguated.json');
    const result = await exportSegmentMembers({
      client,
      segment: 'Shared Name',
      outputFile,
      resultFormat: 'json',
      dataSpace: 'Eurex',
      limit: 200,
      paginationLimits: {},
    });

    expect(result.segmentApiName).to.equal('First');
    expect(result.dataSpace).to.equal('Eurex');
    expect(pageRequests[0]?.path).to.equal('/ssot/segments/First/members');
  });

  it('uses an injected ambiguous picker for interactive selection', async () => {
    const pageRequests: PageOptions[] = [];
    const client = clientWith({
      segments: [
        {
          apiName: 'First',
          displayName: 'Shared Name',
          dataSpace: 'Eurex',
          marketSegmentId: '1sg000000000001',
        },
        {
          apiName: 'Second',
          displayName: 'Shared Name',
          dataSpace: 'OtherBu',
          marketSegmentId: '1sg000000000002',
        },
      ],
      pages: [[{ id: 'member-2' }]],
      pageRequests,
    });
    const outputFile = join(directory, 'basic-picked.json');
    const result = await exportSegmentMembers({
      client,
      segment: 'Shared Name',
      outputFile,
      resultFormat: 'json',
      limit: 200,
      paginationLimits: {},
      resolveAmbiguous: async (candidates) => candidates[1],
    });

    expect(result.segmentApiName).to.equal('Second');
    expect(result.dataSpace).to.equal('OtherBu');
    expect(pageRequests[0]?.path).to.equal('/ssot/segments/Second/members');
  });

  it('throws a non-interactive ambiguous error listing data spaces and MarketSegment Ids', async () => {
    const client = clientWith({
      segments: [
        {
          apiName: 'First',
          displayName: 'Shared Name',
          dataSpace: 'Eurex',
          marketSegmentId: '1sg000000000001',
        },
        {
          apiName: 'Second',
          displayName: 'Shared Name',
          dataSpace: 'OtherBu',
          marketSegmentId: '1sg000000000002',
        },
      ],
      pages: [[{ id: 'unused' }]],
    });
    const error = await captureError(
      exportSegmentMembers({
        client,
        segment: 'Shared Name',
        outputFile: join(directory, 'ambiguous.json'),
        resultFormat: 'json',
        limit: 200,
        paginationLimits: {},
      })
    );
    expect(error.name).to.equal('AmbiguousSegmentError');
    expect(error.message).to.contain('data space Eurex');
    expect(error.message).to.contain('data space OtherBu');
    expect(error.message).to.contain('1sg000000000001');
    expect(error.message).to.contain('1sg000000000002');
    expect(error.message).to.contain('--segment');
    expect(error.message).to.contain('--data-space');
    expect(error.message).not.to.contain('Use its API name');
  });

  it('keeps explicit --output-file outside ./data/<data-space>/', async () => {
    const previousCwd = process.cwd();
    process.chdir(directory);
    try {
      const client = clientWith({
        segments: [{ apiName: 'Annual_Promo', dataSpace: 'Eurex' }],
        pages: [[{ id: 'one' }]],
      });
      const result = await exportSegmentMembers({
        client,
        segment: 'Annual_Promo',
        outputFile: 'explicit-out.json',
        resultFormat: 'json',
        limit: 200,
        paginationLimits: {},
      });
      expect(result.outputFile).to.equal(join(directory, 'explicit-out.json'));
      expect(result.outputFile).not.to.match(/[/\\]data[/\\]/u);
      expect(await readdir(directory)).to.deep.equal(['explicit-out.json']);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('uses resolved segment dataSpace, not an explicit header override, for the default directory', async () => {
    const previousCwd = process.cwd();
    process.chdir(directory);
    try {
      const result = await exportSegmentMembers({
        client: clientWith({ segments: [{ apiName: 'Selected', dataSpace: 'ActualSpace' }], pages: [[]] }),
        segment: 'Selected',
        resultFormat: 'json',
        dataSpace: 'HeaderOverride',
        limit: 200,
        paginationLimits: {},
      });
      expect(result.outputFile).to.include(join(directory, 'data', 'ActualSpace'));
      expect(await readdir(join(directory, 'data'))).to.deep.equal(['ActualSpace']);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('does not invent a default directory from the flag when the resolved segment omits dataSpace', async () => {
    const previousCwd = process.cwd();
    process.chdir(directory);
    try {
      const error = await captureError(
        exportSegmentMembers({
          client: clientWith({ segments: [{ apiName: 'Selected' }] }),
          segment: 'Selected',
          resultFormat: 'json',
          dataSpace: 'FlagOnly',
          limit: 200,
          paginationLimits: {},
        })
      );
      expect(error.name).to.equal('MissingDataSpace');
      expect(await readdir(directory)).to.deep.equal([]);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('writes the default path under ./data/<flag-data-space>/ after disambiguation', async () => {
    const previousCwd = process.cwd();
    process.chdir(directory);
    try {
      const client = clientWith({
        segments: [
          {
            apiName: 'First',
            displayName: 'Shared Name',
            dataSpace: 'Eurex',
            marketSegmentId: '1sg000000000001',
          },
          {
            apiName: 'Second',
            displayName: 'Shared Name',
            dataSpace: 'OtherBu',
            marketSegmentId: '1sg000000000002',
          },
        ],
        pages: [[{ id: 'one' }]],
      });
      const result = await exportSegmentMembers({
        client,
        segment: 'Shared Name',
        resultFormat: 'json',
        dataSpace: 'Eurex',
        limit: 200,
        paginationLimits: {},
      });
      expect(result.outputFile).to.match(
        /[/\\]data[/\\]Eurex[/\\]Shared-Name-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/u
      );
      expect(result.dataSpace).to.equal('Eurex');
      expect(await readdir(join(directory, 'data', 'Eurex'))).to.have.length(1);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
