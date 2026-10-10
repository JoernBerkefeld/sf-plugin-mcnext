import { Connection, Org } from '@salesforce/core';
import { expect } from 'chai';
import { McnClient } from '../../src/client/mcnClient.js';
import {
  correlateCampaignSegmentDefinitions,
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

const notFound = (): Error => Object.assign(new Error('Segment not found'), { errorCode: 'ITEM_NOT_FOUND' });
const listEnvelope = (segments: Array<Record<string, unknown>>): Record<string, unknown> => ({
  segments,
  batchSize: segments.length || 200,
  offset: 0,
  totalSize: segments.length,
});

const correlationInput = {
  projectRoot: '.',
  targetOrg: 'source',
  expectedOrgId: '00D000000000001AAA',
  apiVersion: '67.0',
  campaignId: '701000000000001AAA',
};
const strictSegment = {
  apiName: 'Annual_Promo',
  marketSegmentId: '1sg000000000001AAA',
  marketSegmentDefinitionId: '3HX000000000001AAA',
  dataSpace: 'default',
  status: 'ACTIVE',
};
const strictPage = (segments: unknown[], extra = {}): unknown => ({
  segments,
  batchSize: 200,
  offset: 0,
  totalSize: segments.length,
  ...extra,
});
async function correlateFixture(
  options: {
    responses?: unknown[];
    records?: Array<Record<string, unknown>>;
    start?: Record<string, unknown>;
    native?: unknown;
    nativeExit?: number;
    nativeStatus?: number;
    warnings?: unknown;
    orgId?: string;
    input?: Partial<typeof correlationInput> & { dataSpace?: string };
  } = {}
): Promise<{
  actual: Awaited<ReturnType<typeof correlateCampaignSegmentDefinitions>>;
  urls: string[];
  calls: string[][];
}> {
  const urls: string[] = [];
  const calls: string[][] = [];
  const responses = options.responses ?? [strictPage([strictSegment]), { segments: [strictSegment] }];
  const records = options.records ?? [
    {
      Id: '2aF000000000001AAA',
      ApiName: 'CampaignFlow',
      AssociatedRecordId: correlationInput.campaignId,
      SegmentId: strictSegment.marketSegmentId,
    },
  ];
  const connection = {
    instanceUrl: 'https://example.my.salesforce.com',
    retrieveMaxApiVersion: async () => '67.0',
    request: async (args: RequestArgs) => {
      urls.push(args.url);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  } as unknown as Connection;
  const org = {
    getOrgId: () => options.orgId ?? correlationInput.expectedOrgId,
    getConnection: () => connection,
  } as unknown as Org;
  const schema = (name: string, names: string[]): unknown => ({
    name,
    queryable: true,
    fields: names.map((field) => ({ name: field, type: 'string' })),
  });
  const query = (entries: unknown[]): unknown => ({ records: entries, done: true, totalSize: entries.length });
  const replies: unknown[] = [
    query([{ Id: correlationInput.expectedOrgId }]),
    {
      ...(schema('Campaign', ['Id']) as object),
      childRelationships: [{ relationshipName: 'Flows', childSObject: 'FlowRecord', field: 'AssociatedRecordId' }],
    },
    { Id: correlationInput.campaignId },
    schema('FlowRecord', ['Id', 'ApiName', 'AssociatedRecordId', 'SegmentId']),
    query(records),
  ];
  if (records.length) {
    replies.push(
      schema('FlowDefinition', ['Id', 'DeveloperName', 'ActiveVersionId', 'LatestVersionId']),
      schema('Flow', ['Id', 'DefinitionId', 'Metadata'])
    );
    for (const record of records) {
      replies.push(
        query([
          {
            Id: '300000000000001AAA',
            DeveloperName: record.ApiName,
            ActiveVersionId: null,
            LatestVersionId: '301000000000001AAA',
          },
        ])
      );
      replies.push(
        query([
          {
            Id: '301000000000001AAA',
            DefinitionId: '300000000000001AAA',
            Metadata: {
              dataSpace: 'default',
              start: options.start ?? { triggerType: 'Segment', segment: record.SegmentId },
            },
          },
        ])
      );
    }
  }
  const actual = await correlateCampaignSegmentDefinitions(
    { ...correlationInput, ...options.input },
    {
      createOrg: async () => org,
      createClient: async (selectedOrg, api) => {
        expect(selectedOrg).to.equal(org);
        expect(api).to.equal('67.0');
        return McnClient.create(selectedOrg, api);
      },
      core: async (args) => {
        calls.push(args);
        const native = args.includes('metadata');
        return {
          exitCode: native ? options.nativeExit ?? 0 : 0,
          stdout: JSON.stringify({
            status: native ? options.nativeStatus ?? 0 : 0,
            result: native
              ? options.native ?? [
                  {
                    id: strictSegment.marketSegmentDefinitionId,
                    type: 'MarketSegmentDefinition',
                    fullName: 'DifferentNativeName',
                    fileName: 'marketSegmentDefinitions/DifferentNativeName.marketSegmentDefinition',
                  },
                ]
              : replies.shift(),
            ...(native && options.warnings !== undefined ? { warnings: options.warnings } : {}),
          }),
        };
      },
    }
  );
  return { actual, urls, calls };
}

describe('strict Campaign segment correlation', () => {
  it('retains ACTIVE Connect proof but blocks apparently unique native identity without completeness qualification', async () => {
    const { actual, calls, urls } = await correlateFixture();
    expect(actual.state).to.equal('blocked');
    expect(actual.associationPersistence).to.equal('blocked');
    expect(actual.flows[0]).to.include({
      state: 'correlated',
      segmentId: strictSegment.marketSegmentId,
      segmentApiName: strictSegment.apiName,
      segmentDefinitionId: strictSegment.marketSegmentDefinitionId,
    });
    expect(actual.flows[0]).not.to.have.property('nativeMember');
    expect(actual.diagnostics).to.include('native metadata-list completeness unqualified');
    expect(urls).to.deep.equal([
      '/services/data/v67.0/ssot/segments?dataspace=default&batchSize=200&offset=0',
      '/services/data/v67.0/ssot/segments/Annual_Promo',
    ]);
    expect(calls.filter((args) => args.includes('metadata'))).to.have.length(1);
    expect(
      calls.every((args) => !args.includes('retrieve') && !args.includes('deploy') && !args.includes('create'))
    ).to.equal(true);
  });
  for (const native of [
    [],
    [{ id: strictSegment.marketSegmentDefinitionId }, {}, {}],
    Array.from({ length: 4000 }, () => ({ id: strictSegment.marketSegmentDefinitionId })),
  ]) {
    it(`blocks unqualified native arrays of ${native.length} rows without inventing a limit`, async () => {
      const { actual } = await correlateFixture({ native });
      expect(actual.state).to.equal('blocked');
      expect(actual.flows[0].nativeMember).to.equal(undefined);
      expect(actual.diagnostics).to.include('native metadata-list completeness unqualified');
    });
  }
  for (const options of [{ native: {} }, { nativeExit: 1 }, { nativeStatus: 1 }, { warnings: ['partial results'] }]) {
    it(`preserves native failure evidence ${JSON.stringify(options)}`, async () => {
      const { actual } = await correlateFixture(options);
      expect(actual.state).to.equal('blocked');
      expect(actual.diagnostics).to.have.length.greaterThan(1);
      expect(actual.flows[0].nativeMember).to.equal(undefined);
    });
  }
  it('completes zero-flow and explicitly proven null/no-segment selections without Connect/native reads', async () => {
    for (const records of [
      [],
      [
        {
          Id: '2aF000000000001AAA',
          ApiName: 'CampaignFlow',
          AssociatedRecordId: correlationInput.campaignId,
          SegmentId: null,
        },
      ],
    ]) {
      // eslint-disable-next-line no-await-in-loop -- independently verify each proven no-selection case
      const { actual, urls, calls } = await correlateFixture({ records, start: { triggerType: 'Scheduled' } });
      expect(actual.state).to.equal('complete');
      expect(urls).to.deep.equal([]);
      expect(calls.some((args) => args.includes('metadata'))).to.equal(false);
      if (records.length) expect(actual.flows[0].state).to.equal('no-segment');
    }
  });
  for (const segmentId of [undefined, '', null]) {
    it(`does not infer no-segment from ${String(segmentId)} on a Segment trigger`, async () => {
      const record = {
        Id: '2aF000000000001AAA',
        ApiName: 'CampaignFlow',
        AssociatedRecordId: correlationInput.campaignId,
        ...(segmentId === undefined ? {} : { SegmentId: segmentId }),
      };
      const { actual, urls } = await correlateFixture({
        records: [record],
        start: { triggerType: 'Segment', segment: strictSegment.marketSegmentId },
      });
      expect(actual.state).to.equal('blocked');
      expect(actual.flows[0].state).to.equal('blocked');
      expect(urls).to.deep.equal([]);
    });
  }
  for (const start of [
    { triggerType: 'Segment', segment: 'Annual_Promo' },
    { triggerType: 'Segment', segment: '1sg000000000002AAA' },
    { triggerType: 'Scheduled', segment: strictSegment.marketSegmentId },
  ]) {
    it('rejects start ID/API-name/non-Segment conflicts before segment reads', async () => {
      const { actual, urls } = await correlateFixture({ start });
      expect(actual.state).to.equal('blocked');
      expect(urls).to.deep.equal([]);
    });
  }
  for (const options of [
    { orgId: '00D000000000002AAA' },
    { input: { apiVersion: '66.0' } },
    { input: { dataSpace: 'other' } },
  ]) {
    it('rejects altered context before Campaign/Connect reads', async () => {
      const { actual, urls, calls } = await correlateFixture(options);
      expect(actual.state).to.equal('blocked');
      expect(urls).to.deep.equal([]);
      expect(calls).to.deep.equal([]);
    });
  }
  const pageRows = Array.from({ length: 200 }, (_, index) => ({
    ...strictSegment,
    apiName: `Segment_${index}`,
    marketSegmentId: `1sg${String(index + 1).padStart(12, '0')}AAA`,
    marketSegmentDefinitionId: `3HX${String(index + 1).padStart(12, '0')}AAA`,
  }));
  const cursor = '/services/data/v67.0/ssot/segments?dataspace=default&batchSize=200&offset=200';
  for (const pointer of [
    cursor.replace('v67.0', 'v66.0'),
    cursor.replace('/ssot/segments?', '/ssot/segments/Annual_Promo?'),
    cursor.replace('dataspace=default&', ''),
    cursor.replace('default', 'other'),
    `https://foreign.example${cursor}`,
    `//example.my.salesforce.com${cursor}`,
    cursor.replace('offset=200', 'offset=0'),
    `${cursor}&dataspace=default`,
    cursor.replace('/ssot/', '/ssot/../ssot/'),
    '',
    null,
  ]) {
    it(`rejects unsafe cursor without following: ${String(pointer)}`, async () => {
      const { actual, urls } = await correlateFixture({
        responses: [strictPage(pageRows, { totalSize: 201, nextPageUrl: pointer })],
      });
      expect(actual.state).to.equal('blocked');
      expect(urls).to.have.length(1);
      expect(actual.flows[0].segmentDefinitionId).to.equal(undefined);
    });
  }
  it('validates every pointer alias rather than following a first safe pointer', async () => {
    const { actual, urls } = await correlateFixture({
      responses: [
        strictPage(pageRows, { totalSize: 201, nextPageUrl: cursor, nextPageUri: cursor.replace('default', 'other') }),
      ],
    });
    expect(actual.state).to.equal('blocked');
    expect(urls).to.have.length(1);
  });
  it('reconstructs fixed-context pages with safe same-origin pointers or count-only continuation', async () => {
    for (const pointer of [undefined, cursor, `https://example.my.salesforce.com${cursor}`]) {
      const final = {
        ...strictSegment,
        apiName: 'Last',
        marketSegmentId: '1sg000000000999AAA',
        marketSegmentDefinitionId: '3HX000000000999AAA',
      };
      // eslint-disable-next-line no-await-in-loop -- each pointer shape independently exercises reconstruction
      const { actual, urls } = await correlateFixture({
        responses: [
          strictPage(pageRows, { totalSize: 201, ...(pointer === undefined ? {} : { nextPageUrl: pointer }) }),
          strictPage([final], { offset: 200, totalSize: 201 }),
          { segments: [pageRows[0]] },
        ],
      });
      expect(urls[1]).to.equal('/services/data/v67.0/ssot/segments?dataspace=default&batchSize=200&offset=200');
      expect(actual.flows[0].state).to.equal('correlated');
    }
  });
  for (const response of [
    strictPage([strictSegment], { totalSize: 2 }),
    strictPage([strictSegment], { offset: 1 }),
    strictPage([strictSegment], { totalCount: 2 }),
    strictPage([strictSegment], { totalSize: 20_000 }),
    strictPage([strictSegment], { nextPageUrl: cursor }),
    strictPage([strictSegment, strictSegment]),
    { segments: [strictSegment] },
  ]) {
    it('blocks incomplete, conflicting, repeated or bounded collection evidence', async () => {
      const { actual, urls } = await correlateFixture({ responses: [response] });
      expect(actual.state).to.equal('blocked');
      expect(urls).to.have.length(1);
    });
  }
  for (const detail of [
    strictSegment,
    { segments: [] },
    { segments: [{ ...strictSegment, apiName: ' Annual_Promo ' }] },
    { segments: [{ ...strictSegment, marketSegmentDefinitionId: '3HX000000000002AAA' }] },
    { segments: [{ ...strictSegment, dataSpace: 'other' }] },
  ]) {
    it('rejects unwrapped/mismatched raw detail without false absence or native calls', async () => {
      const { actual, calls } = await correlateFixture({ responses: [strictPage([strictSegment]), detail] });
      expect(actual.flows[0].state).to.equal('blocked');
      expect(calls.some((args) => args.includes('metadata'))).to.equal(false);
    });
  }
  for (const extra of [{ totalSize: 202 }, { offset: 0 }, { batchSize: 100 }, { nextRecordsUrl: cursor }]) {
    it('blocks second-page count drift, repeats and terminal continuations', async () => {
      const final = {
        ...strictSegment,
        apiName: 'Last',
        marketSegmentId: '1sg000000000999AAA',
        marketSegmentDefinitionId: '3HX000000000999AAA',
      };
      const { actual, urls } = await correlateFixture({
        responses: [
          strictPage(pageRows, { totalSize: 201, nextPageUrl: cursor }),
          strictPage([final], { offset: 200, totalSize: 201, ...extra }),
        ],
      });
      expect(actual.state).to.equal('blocked');
      expect(urls).to.have.length(2);
      expect(actual.flows[0].state).to.equal('blocked');
    });
  }
  for (const descriptor of [
    { ...strictSegment, apiName: ' Annual_Promo ' },
    { ...strictSegment, marketSegmentDefinitionId: 'bad' },
    { ...strictSegment, dataSpace: 'other' },
  ]) {
    it('blocks selected list schema/identity mismatches before detail', async () => {
      const { actual, urls } = await correlateFixture({ responses: [strictPage([descriptor])] });
      expect(actual.state).to.equal('blocked');
      expect(urls).to.have.length(1);
    });
  }
  it('blocks ambiguous API/definition identities and preserves all independent flows', async () => {
    const other = { ...strictSegment, marketSegmentId: '1sg000000000002AAA' };
    const { actual, urls } = await correlateFixture({ responses: [strictPage([strictSegment, other])] });
    expect(actual.flows[0].state).to.equal('blocked');
    expect(urls).to.have.length(1);
  });
  it('blocks elapsed read bounds both before and after the first collection request', async () => {
    const originalNow = Date.now;
    for (const times of [
      [0, 60_000],
      [0, 0, 60_000],
    ]) {
      try {
        Date.now = (): number => times.shift() ?? 60_000;
        // eslint-disable-next-line no-await-in-loop -- restore the clock for each independent boundary assertion
        const { actual, urls } = await correlateFixture();
        expect(actual.state).to.equal('blocked');
        expect(actual.diagnostics.join(' ')).to.include('time bound');
        expect(urls).to.have.length.at.most(1);
      } finally {
        Date.now = originalNow;
      }
    }
  });
  it('retains different selected definitions independently', async () => {
    const other = {
      ...strictSegment,
      apiName: 'Other',
      marketSegmentId: '1sg000000000002AAA',
      marketSegmentDefinitionId: '3HX000000000002AAA',
    };
    const records = [strictSegment, other].map((segment, index) => ({
      Id: `2aF00000000000${index + 1}AAA`,
      ApiName: `Flow_${index}`,
      AssociatedRecordId: correlationInput.campaignId,
      SegmentId: segment.marketSegmentId,
    }));
    const { actual, urls } = await correlateFixture({
      records,
      responses: [strictPage([strictSegment, other]), { segments: [strictSegment] }, { segments: [other] }],
    });
    expect(actual.flows.map((flow) => flow.segmentDefinitionId)).to.deep.equal([
      strictSegment.marketSegmentDefinitionId,
      other.marketSegmentDefinitionId,
    ]);
    expect(urls).to.have.length(3);
    expect(actual.state).to.equal('blocked');
  });
  it('retains multiple per-flow rows while reusing shared detail proof', async () => {
    const records = [1, 2].map((number) => ({
      Id: `2aF00000000000${number}AAA`,
      ApiName: `Flow_${number}`,
      AssociatedRecordId: correlationInput.campaignId,
      SegmentId: strictSegment.marketSegmentId,
    }));
    const { actual, urls } = await correlateFixture({ records });
    expect(actual.flows).to.have.length(2);
    expect(actual.flows.every((row) => row.state === 'correlated')).to.equal(true);
    expect(urls).to.have.length(2);
  });
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
    expect((await captureError(resolveSegmentApiName(wrongCase.client, 'annual promo'))).name).to.equal(
      'ITEM_NOT_FOUND'
    );
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
