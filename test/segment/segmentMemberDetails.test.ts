import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Org } from '@salesforce/core';
import { expect } from 'chai';
import { McnClient } from '../../src/client/mcnClient.js';
import {
  buildSegmentMemberDetailsSql,
  discoverSegmentMemberDetails,
  escapeData360SqlLiteral,
  escapeSoqlLiteral,
  querySegmentMemberDetails,
  validateDataSpace,
  quoteData360Identifier,
} from '../../src/segment/segmentMemberDetails.js';

type RequestArgs = { body?: string; headers?: Record<string, string>; method: string; url: string };

const detailFields = Array.from({ length: 19 }, (_, index) => ({
  name: index === 0 ? 'ssot__Id__c' : `DetailField${String(index).padStart(2, '0')}__c`,
  displayName: `Detail ${index}`,
  type: index === 0 ? 'Text' : 'String',
  isNullable: index > 0,
  ...(index === 0 ? { keyQualifier: 'KQ_Individual' } : {}),
}));

const metadata = {
  metadata: [
    {
      name: 'Individual_Unified_SM_123__dlm',
      fields: [{ name: 'Id__c' }, { name: 'Individual_Id__c', keyQualifier: 'KQ_Membership' }],
      primaryKeys: ['Id__c'],
      relationships: [
        {
          fromEntity: 'Individual_Unified_SM_123__dlm',
          toEntity: 'UnifiedssotIndividualMkt__dlm',
          fromField: 'Individual_Id__c',
          toField: 'ssot__Id__c',
          fromKeyQualifier: 'KQ_Membership',
          toKeyQualifier: 'KQ_Individual',
          cardinality: 'many-to-one',
        },
      ],
    },
    {
      name: 'UnifiedssotIndividualMkt__dlm',
      fields: detailFields,
      primaryKeys: ['ssot__Id__c'],
      relationships: [],
    },
  ],
};

const source = {
  latestMembershipDmo: 'Individual_Unified_SM_123__dlm',
  segmentOnDmo: 'UnifiedssotIndividualMkt__dlm',
};
const liveFixtureSource = {
  latestMembershipDmo: 'Membership_Selected__dlm',
  segmentOnDmo: 'UnifiedssotIndividualMkt__dlm',
};
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function loadLiveRelationshipFixture(): Promise<typeof metadata> {
  return JSON.parse(
    await readFile(join(fixtureDirectory, 'metadata-selected-relationship-live-sanitized.json'), 'utf8')
  ) as typeof metadata;
}

async function loadLiveQueryFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(fixtureDirectory, 'query-synchronous-live-sanitized.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function metadataForLiveQueryFixture(fixture: Record<string, unknown>): typeof metadata {
  const columns = fixture.metadata as Array<{ name: string; type: string }>;
  const fields = columns.slice(0, -2).map((column, index) => ({
    name: column.name,
    displayName: column.name,
    type: column.type,
    isNullable: true,
    ...(index === 8 ? { keyQualifier: 'KQ_Individual' } : {}),
  }));
  const membership = structuredClone(metadata.metadata[0]);
  membership.relationships[0].toField = fields[8].name;
  return {
    metadata: [membership, { ...metadata.metadata[1], fields, primaryKeys: [fields[8].name] }],
  } as typeof metadata;
}
const outputNames = [
  ...detailFields.map((field) => field.name),
  'membership_key_internal',
  'detail_match_count_internal',
];
const outputMetadata = outputNames.map((name) => ({ name }));

async function clientReturning(responses: unknown[]): Promise<{ client: McnClient; requests: RequestArgs[] }> {
  const requests: RequestArgs[] = [];
  let call = 0;
  const connection = {
    instanceUrl: 'https://example.my.salesforce.com',
    retrieveMaxApiVersion: async () => '67.0',
    request: async (args: RequestArgs) => {
      requests.push(args);
      if (args.url.includes('/query?q=')) {
        const requestedName = args.url.includes('Marketing') ? 'Marketing' : 'default';
        return { records: [{ Id: '0vh000000000001AAA', Name: requestedName }], totalSize: 1, done: true };
      }
      const response = responses[call++];
      if (response instanceof Error) throw response;
      return response;
    },
  } as unknown as Connection;
  const org = { getConnection: () => connection } as unknown as Org;
  return { client: await McnClient.create(org), requests };
}

async function collect(rows: AsyncIterable<readonly unknown[]>): Promise<Array<readonly unknown[]>> {
  const result: Array<readonly unknown[]> = [];
  for await (const item of rows) result.push(item);
  return result;
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected promise to reject');
}

function row(matchCount: number, membership = 'membership-1'): unknown[] {
  return [...detailFields.map((_, index) => (index === 0 ? 'individual-1' : `value-${index}`)), membership, matchCount];
}

describe('segment member detail service', () => {
  it('accepts the sanitized live relationship and primary-key shapes', async () => {
    const fixture = await loadLiveRelationshipFixture();
    const { client } = await clientReturning([fixture]);

    const discovery = await discoverSegmentMemberDetails(client, liveFixtureSource);

    expect(discovery.membershipKeyField).to.equal('Id__c');
    expect(discovery.membershipJoinField).to.equal('Id__c');
    expect(discovery.detailJoinField).to.equal('ssot__Id__c');
    expect(discovery.columns).to.have.length(19);
  });

  it('discovers the documented legacy aliases and preserves all 19 fields in metadata order', async () => {
    const { client, requests } = await clientReturning([metadata]);
    const discovery = await discoverSegmentMemberDetails(client, source);

    expect(discovery.columns.map((column) => column.name)).to.deep.equal(detailFields.map((field) => field.name));
    expect(discovery.membershipKeyField).to.equal('Id__c');
    expect(discovery.membershipJoinField).to.equal('Individual_Id__c');
    expect(discovery.detailJoinField).to.equal('ssot__Id__c');
    expect(requests[0].headers).to.include({ 'Data-Space': 'default' });
  });

  it('ignores unrelated incomplete metadata before, between, and after the exact selected entities', async () => {
    const response = {
      metadata: [
        { name: 'Account_Home__dll' },
        metadata.metadata[0],
        { name: 'Unrelated_Between__dlm', fields: [] },
        metadata.metadata[1],
        { name: 'Unrelated_After__dlm', relationships: [] },
      ],
    };
    const { client } = await clientReturning([response]);

    const discovery = await discoverSegmentMemberDetails(client, source);

    expect(discovery.membershipDmo).to.equal(source.latestMembershipDmo);
    expect(discovery.segmentOnDmo).to.equal(source.segmentOnDmo);
    expect(discovery.columns).to.have.length(19);
  });

  it('quotes validated identifiers, escapes literals, and rejects untrusted identifiers', () => {
    expect(quoteData360Identifier('UnifiedssotIndividualMkt__dlm')).to.equal('"UnifiedssotIndividualMkt__dlm"');
    expect(escapeData360SqlLiteral("O'Brien")).to.equal("'O''Brien'");
    expect(escapeSoqlLiteral("O'Brien\\West")).to.equal("'O\\'Brien\\\\West'");
    expect(() => quoteData360Identifier('unsafe; DROP TABLE x')).to.throw('invalid SQL identifier');
  });

  it('validates data spaces through the authoritative core object', async () => {
    const valid = await clientReturning([]);
    expect(await validateDataSpace(valid.client, 'default')).to.equal('default');
    expect(valid.requests[0].url).to.include(
      '/query?q=SELECT+Id%2C+Name+FROM+DataSpace+WHERE+Name+%3D+%27default%27+LIMIT+2'
    );

    const missingConnection = {
      instanceUrl: 'https://example.my.salesforce.com',
      retrieveMaxApiVersion: async () => '67.0',
      request: async () => ({ records: [], totalSize: 0, done: true }),
    } as unknown as Connection;
    const missingOrg = { getConnection: () => missingConnection } as unknown as Org;
    const error = await captureError(validateDataSpace(await McnClient.create(missingOrg), 'missing'));
    expect(error.name).to.equal('InvalidDataSpace');
  });

  it('builds a deterministic LEFT JOIN with details-only stable aliases', async () => {
    const { client } = await clientReturning([metadata]);
    const discovery = await discoverSegmentMemberDetails(client, source, 'Marketing');
    const sql = buildSegmentMemberDetailsSql(discovery, 10);

    expect(sql).to.contain('LEFT JOIN "UnifiedssotIndividualMkt__dlm" d');
    expect(sql).to.contain('m."Individual_Id__c" IS NOT DISTINCT FROM d."ssot__Id__c"');
    expect(sql.indexOf('d."ssot__Id__c"')).to.be.lessThan(sql.indexOf('d."DetailField01__c"'));
    expect(sql).to.contain('AS "detail_match_count_internal"');
    expect(sql).to.match(/\) bounded_members\nORDER BY "membership_key_internal"\nLIMIT 10$/u);
    expect(() => buildSegmentMemberDetailsSql(discovery, 0)).to.throw('positive integer');
  });

  it('handles a synchronous submission and propagates a Data-Space override', async () => {
    const { client, requests } = await clientReturning([
      metadata,
      { queryId: 'query-sync', status: 'COMPLETED', metadata: outputMetadata, data: [row(1)], totalSize: 1 },
    ]);
    const result = await querySegmentMemberDetails(client, source, { dataSpace: 'Marketing' });

    expect(await collect(result.rows)).to.deep.equal([row(1).slice(0, -2)]);
    expect(requests.slice(1).map((request) => request.headers?.['Data-Space'])).to.deep.equal([
      'Marketing',
      'Marketing',
    ]);
    const submission = JSON.parse(requests[2].body ?? '{}') as { sql: string };
    expect(submission.sql).to.include('LEFT JOIN');
    expect(submission.sql).to.include('ORDER BY "membership_key_internal"');
    expect(submission.sql).to.match(/LIMIT 1000000$/u);
  });

  it('uses max-items as the SQL total bound while rowLimit remains the Query API page size', async () => {
    const bounded = await clientReturning([
      metadata,
      { queryId: 'query-bounded', status: 'COMPLETED' },
      {
        queryId: 'query-bounded',
        metadata: outputMetadata,
        rows: Array.from({ length: 200 }, (_, index) => row(1, `membership-${index + 1}`)),
        offset: 0,
        rowLimit: 200,
        totalCount: 201,
      },
      {
        queryId: 'query-bounded',
        metadata: outputMetadata,
        rows: [row(1, 'membership-201')],
        offset: 200,
        rowLimit: 200,
        totalCount: 201,
      },
    ]);
    const result = await querySegmentMemberDetails(bounded.client, source, {
      rowLimit: 200,
      paginationLimits: { maxItems: 500 },
    });

    expect(await collect(result.rows)).to.have.length(201);
    const submission = JSON.parse(bounded.requests[2].body ?? '{}') as { sql: string };
    expect(submission.sql).to.match(/LIMIT 500$/u);
    expect(bounded.requests.slice(3).map((request) => request.url)).to.deep.equal([
      '/services/data/v67.0/ssot/query-sql/query-bounded',
      '/services/data/v67.0/ssot/query-sql/query-bounded/rows?offset=200&rowLimit=200',
    ]);
  });

  it('fails closed when synchronous rows declare more data without a query ID', async () => {
    const { client } = await clientReturning([
      metadata,
      { status: 'COMPLETED', metadata: outputMetadata, data: [row(1)], totalSize: 2 },
    ]);
    const result = await querySegmentMemberDetails(client, source, { rowLimit: 1 });
    const error = await captureError(collect(result.rows));
    expect(error.name).to.equal('InvalidData360QueryEnvelope');
    expect(error.message).to.contain('conclusively describe one complete page');
  });

  for (const statusCase of [
    { label: 'running', status: 'RUNNING' },
    { label: 'missing', status: undefined },
    { label: 'unknown', status: 'MYSTERY' },
  ]) {
    it(`rejects a no-queryId ${statusCase.label} status before the first row is yielded`, async () => {
      const response = {
        ...(statusCase.status === undefined ? {} : { status: statusCase.status }),
        metadata: outputMetadata,
        data: [row(1)],
        totalSize: 1,
      };
      const { client } = await clientReturning([metadata, response]);
      const result = await querySegmentMemberDetails(client, source);
      const iterator = result.rows[Symbol.asyncIterator]();
      const error = await captureError(iterator.next());

      expect(error.name).to.equal('InvalidData360QueryEnvelope');
      expect(error.message).to.contain('terminal-success status');
    });
  }

  it('accepts a confirmed complete synchronous page without a query ID', async () => {
    const { client } = await clientReturning([
      metadata,
      { status: 'COMPLETED', metadata: outputMetadata, data: [row(1)], totalSize: 1 },
    ]);
    const result = await querySegmentMemberDetails(client, source);
    expect(await collect(result.rows)).to.deep.equal([row(1).slice(0, -2)]);
  });

  it('accepts the sanitized live synchronous Query API envelope', async () => {
    const live = await loadLiveQueryFixture();
    const liveMetadata = metadataForLiveQueryFixture(live);
    const { client } = await clientReturning([liveMetadata, live]);
    const result = await querySegmentMemberDetails(client, source);

    expect(await collect(result.rows)).to.deep.equal([
      Array.from({ length: 19 }, (_, index) => (index === 8 ? 'individual-placeholder' : null)),
    ]);
  });

  for (const malformed of [
    { label: 'nonterminal', change: { completionStatus: 'Running' } },
    { label: 'incomplete returnedRows', change: { returnedRows: 0 } },
    { label: 'incomplete rowCount', change: { rowCount: 0 } },
    { label: 'multiple chunks', change: { chunkCount: 2 } },
    { label: 'incomplete progress', change: { progress: 0.5 } },
  ]) {
    it(`rejects the live synchronous shape when ${malformed.label}`, async () => {
      const live = await loadLiveQueryFixture();
      if ('returnedRows' in malformed.change) live.returnedRows = malformed.change.returnedRows;
      else Object.assign(live.status as Record<string, unknown>, malformed.change);
      const { client } = await clientReturning([metadataForLiveQueryFixture(live), live]);
      const result = await querySegmentMemberDetails(client, source);

      expect((await captureError(collect(result.rows))).name).to.equal('InvalidData360QueryEnvelope');
    });
  }

  it('rejects conflicting top-level and nested completion status values', async () => {
    const live = await loadLiveQueryFixture();
    live.completionStatus = 'Completed';
    const { client } = await clientReturning([metadata, live]);

    expect((await captureError(querySegmentMemberDetails(client, source))).name).to.equal(
      'InvalidData360QueryEnvelope'
    );
  });

  it('polls an asynchronous query then retrieves and paginates rows', async () => {
    const { client, requests } = await clientReturning([
      metadata,
      { queryId: 'query-async', status: 'RUNNING' },
      { queryId: 'query-async', status: 'COMPLETED' },
      {
        queryId: 'query-async',
        metadata: outputMetadata,
        rows: [row(1, 'membership-1')],
        offset: 0,
        rowLimit: 1,
        totalCount: 2,
      },
      {
        queryId: 'query-async',
        metadata: outputMetadata,
        rows: [row(0, 'membership-2')],
        offset: 1,
        rowLimit: 1,
        totalCount: 2,
      },
    ]);
    const result = await querySegmentMemberDetails(client, source, {
      rowLimit: 1,
      polling: { intervalMs: 0, maxAttempts: 2 },
    });

    const rows = await collect(result.rows);
    expect(rows).to.have.length(2);
    expect(rows[1]).to.deep.equal(row(0, 'membership-2').slice(0, -2));
    expect(requests.map((request) => request.url)).to.deep.equal([
      '/services/data/v67.0/query?q=SELECT+Id%2C+Name+FROM+DataSpace+WHERE+Name+%3D+%27default%27+LIMIT+2',
      '/services/data/v67.0/ssot/metadata',
      '/services/data/v67.0/ssot/query-sql',
      '/services/data/v67.0/ssot/query-sql/query-async',
      '/services/data/v67.0/ssot/query-sql/query-async/rows?offset=0&rowLimit=1',
      '/services/data/v67.0/ssot/query-sql/query-async/rows?offset=1&rowLimit=1',
    ]);
  });

  it('retains null detail values for zero matches and fails for multiple matches', async () => {
    const zero = row(0);
    zero.fill(null, 0, detailFields.length);
    const zeroClient = await clientReturning([
      metadata,
      { queryId: 'query-zero', metadata: outputMetadata, data: [zero], totalSize: 1 },
    ]);
    const zeroResult = await querySegmentMemberDetails(zeroClient.client, source);
    expect(await collect(zeroResult.rows)).to.deep.equal([Array.from({ length: 19 }, () => null)]);

    const multipleClient = await clientReturning([
      metadata,
      { queryId: 'query-many', metadata: outputMetadata, data: [row(2)], totalSize: 1 },
    ]);
    const multiple = await querySegmentMemberDetails(multipleClient.client, source);
    const error = await captureError(collect(multiple.rows));
    expect(error.name).to.equal('MultipleSegmentDetailMatches');
    expect(error.message).to.contain('membership-1');
  });

  it('rejects row-width and metadata-order mismatches', async () => {
    const widthClient = await clientReturning([
      metadata,
      { queryId: 'query-width', metadata: outputMetadata, data: [row(1).slice(1)], totalSize: 1 },
    ]);
    const widthResult = await querySegmentMemberDetails(widthClient.client, source);
    expect((await captureError(collect(widthResult.rows))).name).to.equal('Data360RowWidthError');

    const wrongMetadata = [...outputMetadata];
    [wrongMetadata[0], wrongMetadata[1]] = [wrongMetadata[1], wrongMetadata[0]];
    const orderClient = await clientReturning([
      metadata,
      { queryId: 'query-order', metadata: wrongMetadata, data: [row(1)], totalSize: 1 },
    ]);
    const orderResult = await querySegmentMemberDetails(orderClient.client, source);
    expect((await captureError(collect(orderResult.rows))).name).to.equal('InvalidData360QueryMetadata');
  });

  it('fails actionably when an exact selected entity is partial, missing, or duplicated', async () => {
    const partial = structuredClone(metadata);
    partial.metadata[0] = { name: source.latestMembershipDmo } as (typeof metadata.metadata)[number];
    const partialError = await captureError(
      discoverSegmentMemberDetails((await clientReturning([partial])).client, source)
    );
    expect(partialError.name).to.equal('InvalidData360MetadataEntity');
    expect(partialError.message).to.contain(source.latestMembershipDmo);

    const missing = { metadata: [metadata.metadata[0], { name: 'Unrelated__dlm' }] };
    const missingError = await captureError(
      discoverSegmentMemberDetails((await clientReturning([missing])).client, source)
    );
    expect(missingError.name).to.equal('AmbiguousData360Metadata');
    expect(missingError.message).to.contain(source.segmentOnDmo);
    expect(missingError.message).to.contain('found 0');

    const duplicated = {
      metadata: [metadata.metadata[0], metadata.metadata[1], metadata.metadata[1]],
    };
    const duplicateError = await captureError(
      discoverSegmentMemberDetails((await clientReturning([duplicated])).client, source)
    );
    expect(duplicateError.name).to.equal('AmbiguousData360Metadata');
    expect(duplicateError.message).to.contain(source.segmentOnDmo);
    expect(duplicateError.message).to.contain('found 2');
  });

  it('rejects malformed, conflicting, and incoherent relationship shapes', async () => {
    const live = await loadLiveRelationshipFixture();
    const relationship = live.metadata[0].relationships[0] as Record<string, unknown>;

    const missingField = structuredClone(live);
    delete (missingField.metadata[0].relationships[0] as Record<string, unknown>).fromEntityAttribute;
    expect(
      (
        await captureError(
          discoverSegmentMemberDetails((await clientReturning([missingField])).client, liveFixtureSource)
        )
      ).name
    ).to.equal('InvalidData360Value');

    const conflicting = structuredClone(live);
    (conflicting.metadata[0].relationships[0] as Record<string, unknown>).fromField = 'OtherField__c';
    expect(
      (
        await captureError(
          discoverSegmentMemberDetails((await clientReturning([conflicting])).client, liveFixtureSource)
        )
      ).name
    ).to.equal('ConflictingData360RelationshipAlias');

    const wrongEntity = structuredClone(live);
    wrongEntity.metadata[0].relationships[0].fromEntity = 'OtherMembership__dlm';
    expect(
      (
        await captureError(
          discoverSegmentMemberDetails((await clientReturning([wrongEntity])).client, liveFixtureSource)
        )
      ).name
    ).to.equal('AmbiguousSegmentDetailRelationship');

    const wrongCardinality = structuredClone(live);
    wrongCardinality.metadata[0].relationships[0].cardinality = 'ONETOMANY';
    expect(
      (
        await captureError(
          discoverSegmentMemberDetails((await clientReturning([wrongCardinality])).client, liveFixtureSource)
        )
      ).name
    ).to.equal('InvalidSegmentDetailCardinality');

    const missingMetadataField = structuredClone(live);
    relationship.fromEntityAttribute = 'MissingField__c';
    (missingMetadataField.metadata[0].relationships[0] as Record<string, unknown>).fromEntityAttribute =
      relationship.fromEntityAttribute;
    expect(
      (
        await captureError(
          discoverSegmentMemberDetails((await clientReturning([missingMetadataField])).client, liveFixtureSource)
        )
      ).name
    ).to.equal('MissingData360MetadataField');
  });

  it('fails closed for malformed qualifiers and query envelopes', async () => {
    const noQualifier = structuredClone(metadata);
    noQualifier.metadata[0].relationships[0].fromKeyQualifier = '';
    expect(
      (await captureError(discoverSegmentMemberDetails((await clientReturning([noQualifier])).client, source))).name
    ).to.equal('InvalidData360Value');

    const mismatchedQualifier = structuredClone(metadata);
    mismatchedQualifier.metadata[0].fields[1].keyQualifier = 'OTHER';
    expect(
      (await captureError(discoverSegmentMemberDetails((await clientReturning([mismatchedQualifier])).client, source)))
        .name
    ).to.equal('MismatchedSegmentDetailQualifier');

    const malformed = await clientReturning([metadata, { unexpected: true }]);
    expect((await captureError(querySegmentMemberDetails(malformed.client, source))).name).to.equal(
      'InvalidData360QueryEnvelope'
    );
  });

  it('preserves actionable permission and data-space request errors', async () => {
    const denied = Object.assign(new Error('No access to data space Marketing'), { errorCode: 'INSUFFICIENT_ACCESS' });
    const { client } = await clientReturning([denied]);
    const error = await captureError(discoverSegmentMemberDetails(client, source, 'Marketing'));
    expect(error.name).to.equal('INSUFFICIENT_ACCESS');
    expect(error.message).to.contain('No access to data space Marketing');
    expect(error.message).to.contain('/ssot/metadata');
  });
});
