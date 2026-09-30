import { SfError } from '@salesforce/core';
import { McnClient, PaginationLimits } from '../client/mcnClient.js';

const METADATA_PATH = '/ssot/metadata';
const QUERY_PATH = '/ssot/query-sql';
const CORE_QUERY_PATH = '/query';
const DEFAULT_DATA_SPACE = 'default';
const DEFAULT_ROW_LIMIT = 2000;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/u;
const INTERNAL_MEMBERSHIP_COLUMN = 'membership_key_internal';
const INTERNAL_MATCH_COUNT_COLUMN = 'detail_match_count_internal';

/** Segment detail references required to discover an enriched member query. */
export type SegmentMemberDetailSource = {
  latestMembershipDmo: string;
  segmentOnDmo: string;
};

/** Stable output column derived from the segment-on DMO metadata array. */
export type SegmentMemberDetailColumn = {
  name: string;
  label: string;
  dataType?: string;
  nullable?: boolean;
};

/** Validated metadata contract used to build the enriched query. */
export type SegmentMemberDetailDiscovery = {
  dataSpace: string;
  membershipDmo: string;
  segmentOnDmo: string;
  membershipKeyField: string;
  membershipJoinField: string;
  detailJoinField: string;
  columns: SegmentMemberDetailColumn[];
};

/** Query execution safety limits. */
export type SegmentMemberDetailQueryOptions = {
  dataSpace?: string;
  rowLimit?: number;
  polling?: {
    maxAttempts?: number;
    maxDurationMs?: number;
    intervalMs?: number;
  };
  paginationLimits?: PaginationLimits;
};

/** Metadata plus an incremental iterator of details-only rows. */
export type SegmentMemberDetailResult = {
  columns: SegmentMemberDetailColumn[];
  rows: AsyncIterable<readonly unknown[]>;
};

type MetadataField = {
  name: string;
  displayName?: string;
  type?: string;
  isNullable?: boolean;
  keyQualifier?: string;
};

type MetadataRelationship = {
  fromEntity: string;
  toEntity: string;
  fromField: string;
  toField: string;
  fromKeyQualifier?: string;
  toKeyQualifier?: string;
  cardinality: string;
};

type MetadataEntity = {
  name: string;
  fields: MetadataField[];
  relationships: MetadataRelationship[];
  primaryKeys: string[];
};

type QueryPage = {
  queryId?: string;
  status?: string;
  metadata?: unknown;
  data?: unknown;
  rows?: unknown;
  offset?: unknown;
  rowLimit?: unknown;
  totalSize?: unknown;
  totalCount?: unknown;
  returnedRows?: unknown;
  completionStatus?: unknown;
  rowCount?: unknown;
  rowsProcessed?: unknown;
  chunkCount?: unknown;
  progress?: unknown;
};

/** Escape one Data 360 SQL string literal. */
export function escapeData360SqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Escape one SOQL string literal used for core provenance validation. */
export function escapeSoqlLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** Quote a metadata-validated Data 360 SQL identifier. */
export function quoteData360Identifier(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new SfError(`Metadata contains an invalid SQL identifier: ${identifier}.`, 'InvalidData360Identifier');
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Validate an accessible DataSpace record before relying on Data 360 headers. */
export async function validateDataSpace(client: McnClient, dataSpace = DEFAULT_DATA_SPACE): Promise<string> {
  const normalizedSpace = requireNonempty(dataSpace, 'Data space');
  const response = await client.request<unknown>({
    path: CORE_QUERY_PATH,
    query: {
      q: `SELECT Id, Name FROM DataSpace WHERE Name = ${escapeSoqlLiteral(normalizedSpace)} LIMIT 2`,
    },
  });
  const envelope = asRecord(response, 'DataSpace query response');
  if (!Array.isArray(envelope.records)) {
    throw new SfError('DataSpace query response is missing records.', 'InvalidDataSpaceQueryEnvelope');
  }
  const matches = envelope.records.filter((record) => {
    const candidate = asRecord(record, 'DataSpace query record');
    return candidate.Name === normalizedSpace && typeof candidate.Id === 'string' && candidate.Id.startsWith('0vh');
  });
  if (matches.length !== 1 || envelope.totalSize !== 1 || envelope.done !== true) {
    throw new SfError(
      `Data space ${normalizedSpace} is unavailable or ambiguous for the authorized org user.`,
      'InvalidDataSpace'
    );
  }
  return normalizedSpace;
}

/** Discover and validate the two DMOs, their one-to-one relationship, and all 19 detail fields. */
export async function discoverSegmentMemberDetails(
  client: McnClient,
  source: SegmentMemberDetailSource,
  dataSpace = DEFAULT_DATA_SPACE
): Promise<SegmentMemberDetailDiscovery> {
  const normalizedSpace = requireNonempty(dataSpace, 'Data space');
  const membershipName = requireIdentifier(source.latestMembershipDmo, 'latest membership DMO');
  const detailName = requireIdentifier(source.segmentOnDmo, 'segment-on DMO');
  const response = await client.request<unknown>({
    path: METADATA_PATH,
    headers: { 'Data-Space': normalizedSpace },
  });
  const { membership, detail } = selectMetadataEntities(response, membershipName, detailName);
  if (detail.name !== 'UnifiedssotIndividualMkt__dlm') {
    throw new SfError(
      `Segment-on DMO ${detail.name} is unsupported; expected UnifiedssotIndividualMkt__dlm.`,
      'UnsupportedSegmentOnDmo'
    );
  }
  if (detail.fields.length !== 19) {
    throw new SfError(
      `Segment-on DMO ${detail.name} exposes ${detail.fields.length} fields; exactly 19 are required.`,
      'UnexpectedSegmentDetailFieldCount'
    );
  }

  const relationships = membership.relationships.filter(
    (relationship) => relationship.fromEntity === membership.name && relationship.toEntity === detail.name
  );
  const relationship = exactlyOneRelationship(relationships, membership.name, detail.name);
  if (!['ntoone', 'many-to-one', 'many_to_one', 'n:1'].includes(relationship.cardinality.toLowerCase())) {
    throw new SfError(
      `Relationship ${membership.name} to ${detail.name} has unsupported cardinality ${relationship.cardinality}.`,
      'InvalidSegmentDetailCardinality'
    );
  }
  requireRelationshipField(membership, relationship.fromField, relationship.fromKeyQualifier);
  requireRelationshipField(detail, relationship.toField, relationship.toKeyQualifier);
  const membershipKeyField = exactlyOne(membership.primaryKeys, `${membership.name} primary key`);
  requireField(membership, membershipKeyField);

  return {
    dataSpace: normalizedSpace,
    membershipDmo: membership.name,
    segmentOnDmo: detail.name,
    membershipKeyField,
    membershipJoinField: relationship.fromField,
    detailJoinField: relationship.toField,
    columns: detail.fields.map((field) => ({
      name: field.name,
      label: field.displayName ?? field.name,
      ...(field.type ? { dataType: field.type } : {}),
      ...(field.isNullable === undefined ? {} : { nullable: field.isNullable }),
    })),
  };
}

/** Build deterministic, server-bounded details-only SQL from validated discovery metadata. */
export function buildSegmentMemberDetailsSql(discovery: SegmentMemberDetailDiscovery, rowLimit: number): string {
  if (!Number.isSafeInteger(rowLimit) || rowLimit <= 0) {
    throw new SfError('Data 360 SQL row limit must be a positive integer.', 'InvalidData360RowLimit');
  }
  const membership = quoteData360Identifier(discovery.membershipDmo);
  const detail = quoteData360Identifier(discovery.segmentOnDmo);
  const membershipKey = quoteData360Identifier(discovery.membershipKeyField);
  const membershipJoin = quoteData360Identifier(discovery.membershipJoinField);
  const detailJoin = quoteData360Identifier(discovery.detailJoinField);
  const projections = discovery.columns.map(
    (column) => `d.${quoteData360Identifier(column.name)} AS ${quoteData360Identifier(column.name)}`
  );
  projections.push(`m.${membershipKey} AS ${quoteData360Identifier(INTERNAL_MEMBERSHIP_COLUMN)}`);
  projections.push(
    `COUNT(d.${detailJoin}) OVER (PARTITION BY m.${membershipKey}) AS ${quoteData360Identifier(
      INTERNAL_MATCH_COUNT_COLUMN
    )}`
  );
  const innerQuery = `SELECT\n    ${projections.join(
    ',\n    '
  )}\n  FROM ${membership} m\n  LEFT JOIN ${detail} d\n    ON m.${membershipJoin} IS NOT DISTINCT FROM d.${detailJoin}`;
  const membershipAlias = quoteData360Identifier(INTERNAL_MEMBERSHIP_COLUMN);
  return `SELECT *\nFROM (\n  ${innerQuery.replaceAll(
    '\n',
    '\n  '
  )}\n) bounded_members\nORDER BY ${membershipAlias}\nLIMIT ${rowLimit}`;
}

/** Discover, execute, and expose validated details-only rows for later command integration. */
export async function querySegmentMemberDetails(
  client: McnClient,
  source: SegmentMemberDetailSource,
  options: SegmentMemberDetailQueryOptions = {}
): Promise<SegmentMemberDetailResult> {
  const dataSpace = await validateDataSpace(client, options.dataSpace);
  const discovery = await discoverSegmentMemberDetails(client, source, dataSpace);
  const rowLimit = options.rowLimit ?? DEFAULT_ROW_LIMIT;
  const outputLimit = Math.min(rowLimit, options.paginationLimits?.maxItems ?? rowLimit);
  const sql = buildSegmentMemberDetailsSql(discovery, outputLimit);
  const submission = await client.request<unknown>({
    path: QUERY_PATH,
    method: 'POST',
    body: { sql },
    headers: { 'Data-Space': discovery.dataSpace },
  });
  const initial = parseQueryEnvelope(submission, 'query submission');
  const ready = await awaitReadyQuery(client, initial, discovery.dataSpace, options.polling);
  const expectedNames = [
    ...discovery.columns.map((column) => column.name),
    INTERNAL_MEMBERSHIP_COLUMN,
    INTERNAL_MATCH_COUNT_COLUMN,
  ];
  const rows = iterateQueryRows(client, ready, discovery.dataSpace, expectedNames, options);
  return { columns: discovery.columns, rows };
}

async function awaitReadyQuery(
  client: McnClient,
  initial: QueryPage,
  dataSpace: string,
  limits: SegmentMemberDetailQueryOptions['polling'] = {}
): Promise<QueryPage> {
  if (hasRows(initial)) return initial;
  const queryId = requireNonempty(initial.queryId ?? '', 'Query ID');
  const maxAttempts = limits.maxAttempts ?? 60;
  const maxDurationMs = limits.maxDurationMs ?? 5 * 60 * 1000;
  const intervalMs = limits.intervalMs ?? 250;
  const started = Date.now();
  for (let attempt = 0; attempt < maxAttempts && Date.now() - started <= maxDurationMs; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- query status polling is intentionally sequential
    if (attempt > 0 && intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    // eslint-disable-next-line no-await-in-loop -- each status request depends on the prior response
    const response = await client.request<unknown>({
      path: `${QUERY_PATH}/${encodeURIComponent(queryId)}`,
      headers: { 'Data-Space': dataSpace },
    });
    const status = parseQueryEnvelope(response, 'query status');
    if (hasRows(status) || isComplete(status.status)) return { ...status, queryId };
    if (isFailed(status.status)) {
      throw new SfError(`Data 360 query ${queryId} ended with status ${String(status.status)}.`, 'Data360QueryFailed');
    }
  }
  throw new SfError(`Data 360 query ${queryId} did not complete within polling limits.`, 'Data360QueryTimeout');
}

// eslint-disable-next-line complexity -- pagination, envelope validation, and cardinality checks are one safety boundary
async function* iterateQueryRows(
  client: McnClient,
  initial: QueryPage,
  dataSpace: string,
  expectedNames: string[],
  options: SegmentMemberDetailQueryOptions
): AsyncGenerator<readonly unknown[]> {
  let page = initial;
  let offset = 0;
  let pages = 0;
  let emitted = 0;
  const rowLimit = options.rowLimit ?? DEFAULT_ROW_LIMIT;
  const maxPages = options.paginationLimits?.maxPages ?? 1000;
  const maxItems = options.paginationLimits?.maxItems ?? 1_000_000;
  const maxDurationMs = options.paginationLimits?.maxDurationMs ?? 15 * 60 * 1000;
  const started = Date.now();
  const queryId = page.queryId?.trim() || undefined; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing -- an empty query ID is unusable

  for (;;) {
    if (pages >= maxPages || Date.now() - started >= maxDurationMs)
      throw new SfError('Data 360 row pagination exceeded configured limits.', 'Data360RowsLimitError');
    if (!hasRows(page)) {
      if (!queryId)
        throw new SfError('Completed query response is missing queryId and rows.', 'InvalidData360QueryEnvelope');
      // eslint-disable-next-line no-await-in-loop -- every page offset depends on the prior page
      const response = await client.request<unknown>({
        path: `${QUERY_PATH}/${encodeURIComponent(queryId)}/rows`,
        query: { offset, rowLimit },
        headers: { 'Data-Space': dataSpace },
      });
      page = parseQueryEnvelope(response, 'query rows');
    }
    const rows = getRows(page);
    validateColumnMetadata(page.metadata, expectedNames);
    const total = numericTotal(page);
    validateRowsPage(page, offset, rowLimit, rows.length, total);
    if (!queryId) validateTerminalSinglePage(page, rows.length, total);
    pages += 1;
    emitted += rows.length;
    if (emitted > maxItems)
      throw new SfError('Data 360 row pagination exceeded the item limit.', 'Data360RowsLimitError');
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== expectedNames.length) {
        throw new SfError(
          `Data 360 query row width must be ${expectedNames.length}; received ${
            Array.isArray(row) ? row.length : 'non-array'
          }.`,
          'Data360RowWidthError'
        );
      }
      const matchCount: unknown = row.at(-1);
      if (typeof matchCount !== 'number' || !Number.isSafeInteger(matchCount) || matchCount < 0) {
        throw new SfError('Data 360 query returned an invalid detail match count.', 'InvalidData360MatchCount');
      }
      if (matchCount > 1) {
        throw new SfError(
          `Membership ${String(row.at(-2))} matched ${matchCount} segment detail rows; expected at most one.`,
          'MultipleSegmentDetailMatches'
        );
      }
      yield row.slice(0, -2);
    }
    offset += rows.length;
    if (rows.length === 0 || (total !== undefined && offset >= total)) return;
    if (!queryId) return;
    page = { queryId };
  }
}

function selectMetadataEntities(
  value: unknown,
  membershipName: string,
  detailName: string
): { membership: MetadataEntity; detail: MetadataEntity } {
  const envelope = asRecord(value, 'Data 360 metadata response');
  if (!Array.isArray(envelope.metadata))
    throw new SfError('Data 360 metadata response is missing metadata array.', 'InvalidData360MetadataEnvelope');
  const metadataCandidates: unknown[] = envelope.metadata;

  const select = (name: string): MetadataEntity => {
    const matches = metadataCandidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(
        ({ candidate }) =>
          typeof candidate === 'object' &&
          candidate !== null &&
          !Array.isArray(candidate) &&
          (candidate as Record<string, unknown>).name === name
      );
    if (matches.length !== 1) {
      throw new SfError(
        `Expected exactly one metadata entity named ${name}; found ${matches.length}.`,
        'AmbiguousData360Metadata'
      );
    }
    return parseEntity(matches[0].candidate, matches[0].index);
  };

  return { membership: select(membershipName), detail: select(detailName) };
}

function parseEntity(value: unknown, index: number): MetadataEntity {
  const entity = asRecord(value, `metadata entity ${index}`);
  const name = requireIdentifier(entity.name, `metadata entity ${index} name`);
  if (!Array.isArray(entity.fields) || !Array.isArray(entity.relationships) || !Array.isArray(entity.primaryKeys)) {
    throw new SfError(`Metadata entity ${name} is incomplete.`, 'InvalidData360MetadataEntity');
  }
  const fields = entity.fields.map((field, fieldIndex) => {
    const record = asRecord(field, `${name} field ${fieldIndex}`);
    return {
      name: requireIdentifier(record.name, `${name} field ${fieldIndex} name`),
      ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
      ...(typeof record.type === 'string' ? { type: record.type } : {}),
      ...(typeof record.isNullable === 'boolean' ? { isNullable: record.isNullable } : {}),
      ...(typeof record.keyQualifier === 'string' ? { keyQualifier: record.keyQualifier } : {}),
    };
  });
  if (new Set(fields.map((field) => field.name)).size !== fields.length)
    throw new SfError(`Metadata entity ${name} contains duplicate fields.`, 'DuplicateData360MetadataField');
  const relationships = entity.relationships.map((relationship, relationshipIndex) =>
    parseRelationship(relationship, `${name} relationship ${relationshipIndex}`)
  );
  const primaryKeys = entity.primaryKeys.map((key, keyIndex) =>
    parsePrimaryKey(key, `${name} primary key ${keyIndex}`)
  );
  return { name, fields, relationships, primaryKeys };
}

// eslint-disable-next-line complexity -- envelope alias conflicts are validated at one trust boundary
function parseQueryEnvelope(value: unknown, label: string): QueryPage {
  const record = asRecord(value, `Data 360 ${label} response`);
  const topLevelStatus = typeof record.status === 'string' ? record.status : undefined;
  const nestedStatus =
    record.status === undefined || topLevelStatus !== undefined
      ? undefined
      : asRecord(record.status, `Data 360 ${label} status`);
  const nestedCompletion = nestedStatus?.completionStatus;
  if (
    topLevelStatus !== undefined &&
    typeof nestedCompletion === 'string' &&
    topLevelStatus.toLowerCase() !== nestedCompletion.toLowerCase()
  ) {
    throw new SfError(`Data 360 ${label} response has conflicting status values.`, 'InvalidData360QueryEnvelope');
  }
  const topLevelCompletion = record.completionStatus;
  if (
    typeof topLevelCompletion === 'string' &&
    typeof nestedCompletion === 'string' &&
    topLevelCompletion.toLowerCase() !== nestedCompletion.toLowerCase()
  ) {
    throw new SfError(`Data 360 ${label} response has conflicting completion statuses.`, 'InvalidData360QueryEnvelope');
  }
  const nestedQueryId = nestedStatus?.queryId;
  if (
    typeof record.queryId === 'string' &&
    typeof nestedQueryId === 'string' &&
    record.queryId.trim() !== nestedQueryId.trim()
  ) {
    throw new SfError(`Data 360 ${label} response has conflicting query IDs.`, 'InvalidData360QueryEnvelope');
  }
  const page: QueryPage = {
    ...(typeof record.queryId === 'string' ? { queryId: record.queryId } : {}),
    ...(topLevelStatus === undefined ? {} : { status: topLevelStatus }),
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    ...(record.data === undefined ? {} : { data: record.data }),
    ...(record.rows === undefined ? {} : { rows: record.rows }),
    ...(record.offset === undefined ? {} : { offset: record.offset }),
    ...(record.rowLimit === undefined ? {} : { rowLimit: record.rowLimit }),
    ...(record.totalSize === undefined ? {} : { totalSize: record.totalSize }),
    ...(record.totalCount === undefined ? {} : { totalCount: record.totalCount }),
    ...(record.returnedRows === undefined ? {} : { returnedRows: record.returnedRows }),
    ...(nestedCompletion === undefined
      ? topLevelCompletion === undefined
        ? {}
        : { completionStatus: topLevelCompletion }
      : { completionStatus: nestedCompletion }),
    ...(nestedStatus?.rowCount === undefined ? {} : { rowCount: nestedStatus.rowCount }),
    ...(nestedStatus?.rowsProcessed === undefined ? {} : { rowsProcessed: nestedStatus.rowsProcessed }),
    ...(nestedStatus?.chunkCount === undefined ? {} : { chunkCount: nestedStatus.chunkCount }),
    ...(nestedStatus?.progress === undefined ? {} : { progress: nestedStatus.progress }),
  };
  if (!page.queryId && !page.status && page.completionStatus === undefined && !hasRows(page)) {
    throw new SfError(`Data 360 ${label} response is incomplete.`, 'InvalidData360QueryEnvelope');
  }
  return page;
}

function validateColumnMetadata(value: unknown, expectedNames: string[]): void {
  if (!Array.isArray(value) || value.length !== expectedNames.length) {
    throw new SfError('Data 360 query metadata is missing or has an unexpected width.', 'InvalidData360QueryMetadata');
  }
  const names = value.map((column, index) => {
    const record = asRecord(column, `query metadata column ${index}`);
    return requireIdentifier(record.name, `query metadata column ${index} name`);
  });
  if (names.some((name, index) => name !== expectedNames[index])) {
    throw new SfError(
      'Data 360 query metadata columns do not match the requested stable order.',
      'InvalidData360QueryMetadata'
    );
  }
}

function getRows(page: QueryPage): unknown[] {
  const rows = page.data ?? page.rows;
  if (!Array.isArray(rows))
    throw new SfError('Data 360 query rows response is missing a rows array.', 'InvalidData360RowsEnvelope');
  return rows;
}

function hasRows(page: QueryPage): boolean {
  return Array.isArray(page.data) || Array.isArray(page.rows);
}

function numericTotal(page: QueryPage): number | undefined {
  const total = page.totalSize ?? page.totalCount;
  if (total === undefined) return undefined;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)
    throw new SfError('Data 360 query rows response has an invalid total count.', 'InvalidData360RowsEnvelope');
  return total;
}

function isComplete(status: string | undefined): boolean {
  return ['success', 'succeeded', 'complete', 'completed'].includes(status?.toLowerCase() ?? '');
}

function isFailed(status: string | undefined): boolean {
  return ['failed', 'error', 'cancelled', 'canceled'].includes(status?.toLowerCase() ?? '');
}

function validateTerminalSinglePage(page: QueryPage, rowCount: number, total: number | undefined): void {
  const documentedTerminal = isComplete(page.status) && page.completionStatus === undefined;
  const observedTerminal = page.status === undefined && page.completionStatus === 'ResultsProduced';
  if (!documentedTerminal && !observedTerminal) {
    throw new SfError(
      'Data 360 query response without a top-level queryId must have a recognized terminal-success status before rows can be used.',
      'InvalidData360QueryEnvelope'
    );
  }
  if (observedTerminal) {
    const returnedRows = requireSafeCount(page.returnedRows, 'returnedRows');
    const statusRowCount = requireSafeCount(page.rowCount, 'status.rowCount');
    const rowsProcessed = requireSafeCount(page.rowsProcessed, 'status.rowsProcessed');
    const chunkCount = requireSafeCount(page.chunkCount, 'status.chunkCount');
    if (
      returnedRows !== rowCount ||
      statusRowCount !== rowCount ||
      rowsProcessed < rowCount ||
      chunkCount !== 1 ||
      page.progress !== 1 ||
      total !== undefined
    ) {
      throw new SfError(
        'Data 360 query response without a top-level queryId must conclusively describe one complete page.',
        'InvalidData360QueryEnvelope'
      );
    }
    return;
  }
  if (total === undefined || total !== rowCount) {
    throw new SfError(
      'Data 360 query response without a top-level queryId must conclusively describe one complete page.',
      'InvalidData360QueryEnvelope'
    );
  }
}

function requireSafeCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SfError(`Data 360 query response has an invalid ${label}.`, 'InvalidData360QueryEnvelope');
  }
  return value;
}

function exactlyOne<T>(values: T[], label: string): T {
  if (values.length !== 1)
    throw new SfError(`Expected exactly one ${label}; found ${values.length}.`, 'AmbiguousData360Metadata');
  return values[0];
}

function exactlyOneRelationship(
  values: MetadataRelationship[],
  membership: string,
  detail: string
): MetadataRelationship {
  if (values.length !== 1) {
    throw new SfError(
      `Expected exactly one metadata relationship from ${membership} to ${detail}; found ${values.length}.`,
      'AmbiguousSegmentDetailRelationship'
    );
  }
  return values[0];
}

function requireField(entity: MetadataEntity, fieldName: string): void {
  if (!entity.fields.some((field) => field.name === fieldName))
    throw new SfError(`Metadata field ${entity.name}.${fieldName} does not exist.`, 'MissingData360MetadataField');
}

function requireRelationshipField(entity: MetadataEntity, fieldName: string, qualifier?: string): void {
  requireField(entity, fieldName);
  const field = entity.fields.find((candidate) => candidate.name === fieldName);
  if (qualifier !== undefined && field?.keyQualifier !== qualifier) {
    throw new SfError(
      `Metadata qualifier for ${entity.name}.${fieldName} does not match relationship qualifier ${qualifier}.`,
      'MismatchedSegmentDetailQualifier'
    );
  }
}

function parsePrimaryKey(value: unknown, label: string): string {
  if (typeof value === 'string') return requireIdentifier(value, label);
  return requireIdentifier(asRecord(value, label).name, `${label} name`);
}

function parseRelationship(value: unknown, label: string): MetadataRelationship {
  const record = asRecord(value, label);
  return {
    fromEntity: requireIdentifier(record.fromEntity, `${label} fromEntity`),
    toEntity: requireIdentifier(record.toEntity, `${label} toEntity`),
    fromField: requireRelationshipAlias(record, 'fromField', 'fromEntityAttribute', `${label} from field`),
    toField: requireRelationshipAlias(record, 'toField', 'toEntityAttribute', `${label} to field`),
    ...optionalRelationshipQualifier(record, 'fromKeyQualifier', `${label} fromKeyQualifier`),
    ...optionalRelationshipQualifier(record, 'toKeyQualifier', `${label} toKeyQualifier`),
    cardinality: requireNonempty(record.cardinality, `${label} cardinality`),
  };
}

function requireRelationshipAlias(
  record: Record<string, unknown>,
  legacyName: string,
  currentName: string,
  label: string
): string {
  const legacy = optionalIdentifier(record[legacyName], `${label} (${legacyName})`);
  const current = optionalIdentifier(record[currentName], `${label} (${currentName})`);
  if (legacy !== undefined && current !== undefined && legacy !== current) {
    throw new SfError(`${label} aliases conflict.`, 'ConflictingData360RelationshipAlias');
  }
  const selected = legacy ?? current;
  if (selected === undefined) throw new SfError(`${label} is missing.`, 'InvalidData360Value');
  return selected;
}

function optionalIdentifier(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireIdentifier(value, label);
}

function optionalRelationshipQualifier(
  record: Record<string, unknown>,
  name: 'fromKeyQualifier' | 'toKeyQualifier',
  label: string
): Partial<Pick<MetadataRelationship, 'fromKeyQualifier' | 'toKeyQualifier'>> {
  return record[name] === undefined ? {} : { [name]: requireNonempty(record[name], label) };
}

function validateRowsPage(
  page: QueryPage,
  expectedOffset: number,
  requestedLimit: number,
  rowCount: number,
  total: number | undefined
): void {
  if (page.offset !== undefined && page.offset !== expectedOffset)
    throw new SfError('Data 360 rows response has an unexpected offset.', 'InvalidData360RowsEnvelope');
  if (page.rowLimit !== undefined && page.rowLimit !== requestedLimit)
    throw new SfError('Data 360 rows response has an unexpected rowLimit.', 'InvalidData360RowsEnvelope');
  if (total !== undefined && expectedOffset + rowCount > total)
    throw new SfError('Data 360 rows response exceeds its declared total.', 'InvalidData360RowsEnvelope');
  if (total !== undefined && expectedOffset + rowCount < total && rowCount !== requestedLimit)
    throw new SfError('Data 360 rows response ended before its declared total.', 'InvalidData360RowsEnvelope');
}

function requireIdentifier(value: unknown, label: string): string {
  const text = requireNonempty(value, label);
  quoteData360Identifier(text);
  return text;
}

function requireNonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new SfError(`${label} must be a non-empty string.`, 'InvalidData360Value');
  return value.trim();
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new SfError(`${label} must be an object.`, 'InvalidData360Envelope');
  return value as Record<string, unknown>;
}
