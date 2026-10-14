import { isDeepStrictEqual } from 'node:util';
import { Org } from '@salesforce/core';
import { type CampaignFlowAssociationArtifact } from './campaignFlowRetrieval.js';

/** Explicit caller correspondence; provenance is not a claim of business equivalence. */
export type FlowAssociationInput = {
  operation: 'plan' | 'apply';
  targetOrg: string;
  expectedOrgId: string;
  apiVersion: '67.0';
  artifact: CampaignFlowAssociationArtifact;
  source: { orgId: string; campaignId: string; flowRecordId: string; member: string; segmentId: string };
  target: {
    campaignId: string;
    flowRecordId: string;
    member: string;
    segmentId: string;
    segmentApiName: string;
    segmentDefinitionId: string;
    expectedDefinitionId: string;
    expectedLatestVersionId: string;
  };
};

/** Read channels remain independent; request performs the sole field-only PATCH. */
export type FlowAssociationTransport = {
  resolveOrgId: () => Promise<string>;
  request: (path: string, update?: { method: 'PATCH'; body: { AssociatedRecordId: string } }) => Promise<unknown>;
  query: (soql: string, tooling?: boolean) => Promise<unknown>;
  readFlow: (member: string) => Promise<unknown>;
};
export type FlowAssociationResult = {
  operation: 'plan' | 'apply';
  state: 'planned' | 'attached' | 'noop';
  orgId: string;
  campaignId: string;
  flowRecordId: string;
  segmentId: string;
  definitionId: string;
  latestVersionId: string;
  writeAttempted: boolean;
  writeOutcome: 'not-attempted' | 'acknowledged' | 'ambiguous-reconciled';
};
export type FlowAssociationErrorCode = 'INVALID_INPUT' | 'BLOCKED' | 'CONFLICT' | 'RECONCILIATION_REQUIRED';

/** No error permits a retry, detachment, activation, or deployment fallback. */
export class FlowAssociationError extends Error {
  public constructor(public readonly code: FlowAssociationErrorCode, public readonly writeAttempted = false) {
    super(`Flow association ${code}; no automatic retry, overwrite, detach, activation or deploy fallback`);
    this.name = 'FlowAssociationError';
  }
}

type Row = Record<string, unknown>;
type Snapshot = {
  record: Row;
  campaign: Row;
  definition: Row;
  native: Row;
  tooling: Row;
  segment: Row;
  dataSpace: Row;
  connect: Row;
};
const base = '/services/data/v67.0';
const objectName = 'UnifiedssotIndividualMkt__dlm';

/** Attach one existing inactive Flow using fresh API 67 evidence, never native XML rewriting. */
export async function associateFlow(
  input: FlowAssociationInput,
  transport?: FlowAssociationTransport
): Promise<FlowAssociationResult> {
  validateInput(input);
  const channel = transport ?? (await nativeTransport(input.targetOrg));
  const baseline = await qualify(input, channel);
  const association = baseline.record.AssociatedRecordId;
  if (association !== null && association !== input.target.campaignId) fail('CONFLICT');
  const result: FlowAssociationResult = {
    operation: input.operation,
    state: 'planned',
    orgId: input.expectedOrgId,
    campaignId: input.target.campaignId,
    flowRecordId: input.target.flowRecordId,
    segmentId: input.target.segmentId,
    definitionId: input.target.expectedDefinitionId,
    latestVersionId: input.target.expectedLatestVersionId,
    writeAttempted: false,
    writeOutcome: 'not-attempted',
  };
  // Repeat every mutable prerequisite immediately before the sole write (not atomic CAS).
  const recheck = await qualify(input, channel);
  if (!isDeepStrictEqual(baseline, recheck)) fail('CONFLICT');
  if (association === input.target.campaignId) {
    verifyChild(recheck, input);
    return { ...result, state: 'noop' };
  }
  if (input.operation === 'plan') return result;
  result.writeAttempted = true;
  try {
    await channel.request(`${base}/sobjects/FlowRecord/${input.target.flowRecordId}`, {
      method: 'PATCH',
      body: { AssociatedRecordId: input.target.campaignId },
    });
    result.writeOutcome = 'acknowledged';
  } catch {
    // A transport exception can follow a committed write. Reconcile once; NEVER retry.
    result.writeOutcome = 'ambiguous-reconciled';
  }
  try {
    const after = await qualify(input, channel);
    if (after.record.AssociatedRecordId !== input.target.campaignId) fail('RECONCILIATION_REQUIRED', true);
    verifyChild(after, input);
    // Timestamps legitimately change on attachment; all identity/qualification checks ran again.
    if (
      !isDeepStrictEqual(baseline.native, after.native) ||
      !isDeepStrictEqual(baseline.tooling, after.tooling) ||
      !isDeepStrictEqual(baseline.segment, after.segment) ||
      !isDeepStrictEqual(baseline.dataSpace, after.dataSpace) ||
      !isDeepStrictEqual(baseline.connect, after.connect)
    )
      fail('RECONCILIATION_REQUIRED', true);
  } catch {
    fail('RECONCILIATION_REQUIRED', true);
  }
  return { ...result, state: 'attached' };
}

async function nativeTransport(targetOrg: string): Promise<FlowAssociationTransport> {
  const org = await Org.create({ aliasOrUsername: targetOrg });
  const connection = org.getConnection('67.0');
  return {
    resolveOrgId: async () => (await Org.create({ aliasOrUsername: targetOrg })).getOrgId(),
    request: async (url, update) =>
      connection.request(update ? { url, method: update.method, body: JSON.stringify(update.body) } : url),
    query: async (soql, tooling) => (tooling ? connection.tooling.query(soql) : connection.query(soql)),
    readFlow: async (member) => connection.metadata.read('Flow', member),
  };
}

function validateInput(input: FlowAssociationInput): void {
  if (!input || !['plan', 'apply'].includes(input.operation) || input.apiVersion !== '67.0') fail('INVALID_INPUT');
  if (typeof input.targetOrg !== 'string' || !input.targetOrg.trim() || /[\0\r\n]/.test(input.targetOrg))
    fail('INVALID_INPUT');
  const { source, target, artifact } = input;
  if (!source || !target || !artifact || artifact.schemaVersion !== 1 || artifact.kind !== 'campaign-flow-associations')
    fail('INVALID_INPUT');
  for (const [value, prefix] of [
    [input.expectedOrgId, '00D'],
    [source.orgId, '00D'],
    [source.campaignId, '701'],
    [source.flowRecordId, '2aF'],
    [source.segmentId, '1sg'],
    [target.campaignId, '701'],
    [target.flowRecordId, '2aF'],
    [target.segmentId, '1sg'],
    [target.segmentDefinitionId, '3HX'],
    [target.expectedDefinitionId, '300'],
    [target.expectedLatestVersionId, '301'],
  ]) {
    if (typeof value !== 'string' || !new RegExp(`^${prefix}[A-Za-z0-9]{15}$`).test(value)) fail('INVALID_INPUT');
  }
  for (const member of [source.member, target.member, target.segmentApiName]) {
    if (typeof member !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(member)) fail('INVALID_INPUT');
  }
  validateProvenance(input);
}

function validateProvenance({ artifact, source }: FlowAssociationInput): void {
  if (
    !artifact.source ||
    artifact.source.orgId !== source.orgId ||
    artifact.source.campaignId !== source.campaignId ||
    artifact.source.apiVersion !== '67.0' ||
    !Array.isArray(artifact.flows)
  )
    fail('INVALID_INPUT');
  const selected = artifact.flows.filter(
    (flow) => flow.flowRecordId === source.flowRecordId || flow.member === source.member
  );
  if (selected.length !== 1) fail('INVALID_INPUT');
  const flow = selected[0];
  if (
    flow.flowRecordId !== source.flowRecordId ||
    flow.member !== source.member ||
    flow.associatedRecordId !== source.campaignId ||
    flow.segmentId !== source.segmentId ||
    !/^300[A-Za-z0-9]{15}$/.test(flow.definitionId) ||
    !/^301[A-Za-z0-9]{15}$/.test(flow.latestVersionId) ||
    !/^[a-f0-9]{64}$/.test(flow.nativeSha256) ||
    typeof flow.nativeFile !== 'string' ||
    !flow.nativeFile
  )
    fail('INVALID_INPUT');
}

async function qualify(input: FlowAssociationInput, channel: FlowAssociationTransport): Promise<Snapshot> {
  const t = input.target;
  if ((await channel.resolveOrgId()) !== input.expectedOrgId) fail('BLOCKED');
  const organization = one(await channel.query('SELECT Id FROM Organization'));
  if (organization.Id !== input.expectedOrgId) fail('BLOCKED');
  const deployments = rows(
    await channel.query(
      "SELECT Id, Status, CheckOnly, CreatedDate FROM DeployRequest WHERE Status IN ('Pending','InProgress','Finalizing','Canceling') ORDER BY CreatedDate DESC LIMIT 20",
      true
    )
  );
  if (deployments.length) fail('BLOCKED');
  verifySchema(row(await channel.request(`${base}/sobjects/FlowRecord/describe`)));
  const record = row(await channel.request(`${base}/sobjects/FlowRecord/${t.flowRecordId}`));
  verifyRecord(record, t);
  const campaign = one(
    await channel.query(
      `SELECT Id, IsActive, (SELECT Id, ApiName, AssociatedRecordId, SegmentId, ActiveVersionId FROM Flows) FROM Campaign WHERE Id = '${t.campaignId}'`
    )
  );
  if (campaign.Id !== t.campaignId || campaign.IsActive !== false) fail('BLOCKED');
  const definition = one(
    await channel.query(
      `SELECT Id, DeveloperName, ActiveVersionId, LatestVersionId FROM FlowDefinition WHERE DeveloperName = '${t.member}'`,
      true
    )
  );
  if (
    definition.Id !== t.expectedDefinitionId ||
    definition.DeveloperName !== t.member ||
    definition.LatestVersionId !== t.expectedLatestVersionId ||
    definition.ActiveVersionId !== null
  )
    fail('BLOCKED');
  const version = row(await channel.request(`${base}/tooling/sobjects/Flow/${t.expectedLatestVersionId}`));
  if (version.Id !== t.expectedLatestVersionId || version.DefinitionId !== t.expectedDefinitionId) fail('BLOCKED');
  const native = row(await channel.readFlow(t.member));
  if (native.fullName !== t.member) fail('BLOCKED');
  const metadata = row(version.Metadata);
  const nativeShape = flowShape(native, t.segmentId);
  if (!isDeepStrictEqual(nativeShape, flowShape(metadata, t.segmentId))) fail('BLOCKED');
  const segment = row(await channel.request(`${base}/sobjects/MarketSegment/${t.segmentId}`));
  verifySegment(segment, t.segmentId);
  const dataSpace = one(
    await channel.query(
      `SELECT Id, DataSpaceApiName, Status, IsDeleted FROM DataSpace WHERE Id = '${String(segment.DataSpaceId)}'`
    )
  );
  if (
    dataSpace.Id !== segment.DataSpaceId ||
    dataSpace.DataSpaceApiName !== 'default' ||
    dataSpace.Status !== 'ACTIVE' ||
    dataSpace.IsDeleted !== false
  )
    fail('BLOCKED');
  const connect = await verifyConnect(input, channel);
  return {
    record: pick(record, [
      'Id',
      'ApiName',
      'SegmentId',
      'ActiveVersionId',
      'ProgressStatus',
      'AssociatedRecordId',
      'LastModifiedDate',
      'SystemModstamp',
    ]),
    campaign: { Id: campaign.Id, IsActive: campaign.IsActive, Flows: campaign.Flows },
    definition: pick(definition, ['Id', 'DeveloperName', 'LatestVersionId', 'ActiveVersionId']),
    native,
    tooling: version,
    connect,
    segment: pick(segment, [
      'Id',
      'DataSpaceId',
      'IsDeleted',
      'MarketSegmentType',
      'SegmentStatus',
      'PublishStatus',
      'PublishScheduleInterval',
    ]),
    dataSpace: pick(dataSpace, ['Id', 'DataSpaceApiName', 'Status', 'IsDeleted']),
  };
}

function verifySchema(schema: Row): void {
  const fields = Array.isArray(schema.fields)
    ? schema.fields.filter((field: unknown) => isRow(field) && field.name === 'AssociatedRecordId')
    : [];
  if (schema.name !== 'FlowRecord' || schema.updateable !== true || fields.length !== 1) fail('BLOCKED');
  const field = row(fields[0]);
  if (field.updateable !== true || !Array.isArray(field.referenceTo) || !field.referenceTo.includes('Campaign'))
    fail('BLOCKED');
}
function verifyRecord(record: Row, t: FlowAssociationInput['target']): void {
  if (
    record.Id !== t.flowRecordId ||
    record.ApiName !== t.member ||
    record.SegmentId !== t.segmentId ||
    record.ActiveVersionId !== null ||
    record.ProgressStatus !== 'Draft' ||
    !(record.AssociatedRecordId === null || typeof record.AssociatedRecordId === 'string')
  )
    fail('BLOCKED');
}
function verifySegment(segment: Row, segmentId: string): void {
  if (
    segment.Id !== segmentId ||
    segment.IsDeleted !== false ||
    segment.MarketSegmentType !== 'DBT' ||
    segment.SegmentStatus !== 'ACTIVE' ||
    segment.PublishStatus !== null ||
    segment.PublishScheduleInterval !== 'NO_REFRESH'
  )
    fail('BLOCKED');
  if (typeof segment.DataSpaceId !== 'string' || !/^0vh[A-Za-z0-9]{15}$/.test(segment.DataSpaceId)) fail('BLOCKED');
}
function verifyConnectEntry(entry: Row, t: FlowAssociationInput['target']): void {
  if (
    entry.marketSegmentId !== t.segmentId ||
    entry.apiName !== t.segmentApiName ||
    entry.marketSegmentDefinitionId !== t.segmentDefinitionId ||
    entry.segmentType !== 'DBT' ||
    entry.segmentStatus !== 'ACTIVE' ||
    entry.publishInterval !== 'NO_REFRESH' ||
    (entry.publishStatus !== undefined && entry.publishStatus !== null) ||
    entry.dataSpace !== 'default' ||
    entry.segmentOnApiName !== objectName ||
    typeof entry.segmentOnId !== 'string' ||
    !entry.segmentOnId
  )
    fail('BLOCKED');
}

function flowShape(metadata: Row, segmentId: string): Row {
  const start = row(metadata.start);
  if (
    !['Draft', 'InvalidDraft'].includes(String(metadata.status)) ||
    metadata.processType !== 'AutoLaunchedFlow' ||
    metadata.dataSpace !== 'default' ||
    start.triggerType !== 'Segment' ||
    start.segment !== segmentId ||
    start.object !== objectName
  )
    fail('BLOCKED');
  return {
    status: metadata.status,
    processType: metadata.processType,
    dataSpace: metadata.dataSpace,
    start: pick(start, ['triggerType', 'segment', 'object']),
  };
}

async function verifyConnect(input: FlowAssociationInput, channel: FlowAssociationTransport): Promise<Row> {
  const t = input.target;
  const matches: Row[] = [];
  let offset = 0;
  let total = -1;
  do {
    // eslint-disable-next-line no-await-in-loop -- exhaust authoritative pages to reject ambiguous identities
    const page = row(await channel.request(`${base}/ssot/segments?batchSize=50&offset=${offset}&dataspace=default`));
    if (
      !Array.isArray(page.segments) ||
      typeof page.totalSize !== 'number' ||
      !Number.isSafeInteger(page.totalSize) ||
      page.totalSize < 0 ||
      page.offset !== offset
    )
      fail('BLOCKED');
    if (offset && total !== page.totalSize) fail('BLOCKED');
    total = page.totalSize;
    const entries = page.segments.map((entry: unknown) => row(entry));
    matches.push(
      ...entries.filter((entry) => entry.marketSegmentId === t.segmentId || entry.apiName === t.segmentApiName)
    );
    if (!entries.length && offset < total) fail('BLOCKED');
    offset += entries.length;
  } while (offset < total);
  if (matches.length !== 1) fail('BLOCKED');
  const details = row(
    await channel.request(`${base}/ssot/segments/${encodeURIComponent(t.segmentApiName)}?dataspace=default`)
  );
  if (!Array.isArray(details.segments) || details.segments.length !== 1) fail('BLOCKED');
  const detail = row(details.segments[0]);
  for (const entry of [matches[0], detail]) verifyConnectEntry(entry, t);
  if (matches[0].segmentOnId !== detail.segmentOnId) fail('BLOCKED');
  return pick(detail, [
    'marketSegmentId',
    'apiName',
    'marketSegmentDefinitionId',
    'segmentType',
    'segmentStatus',
    'publishInterval',
    'publishStatus',
    'dataSpace',
    'segmentOnApiName',
    'segmentOnId',
  ]);
}

function verifyChild(snapshot: Snapshot, input: FlowAssociationInput): void {
  const children = rows(snapshot.campaign.Flows);
  const matching = children.filter((child) => child.Id === input.target.flowRecordId);
  if (matching.length !== 1) fail('BLOCKED');
  const child = matching[0];
  if (
    child.ApiName !== input.target.member ||
    child.AssociatedRecordId !== input.target.campaignId ||
    child.SegmentId !== input.target.segmentId ||
    child.ActiveVersionId !== null
  )
    fail('BLOCKED');
}
function pick(value: Row, keys: string[]): Row {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
function isRow(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function row(value: unknown): Row {
  if (!isRow(value)) fail('BLOCKED');
  return value;
}
function rows(value: unknown): Row[] {
  const envelope = row(value);
  if (envelope.done !== true || !Array.isArray(envelope.records) || envelope.totalSize !== envelope.records.length)
    fail('BLOCKED');
  return envelope.records.map((entry: unknown) => row(entry));
}
function one(value: unknown): Row {
  const records = rows(value);
  if (records.length !== 1) fail('BLOCKED');
  return records[0];
}
function fail(code: FlowAssociationErrorCode, attempted = false): never {
  throw new FlowAssociationError(code, attempted);
}
