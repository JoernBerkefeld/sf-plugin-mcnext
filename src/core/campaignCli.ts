import { realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { runCore, type CoreRunner } from './flowCli.js';

const fields = ['Name', 'Type', 'Status', 'IsActive', 'Description'];
const relationships = ['ParentId', 'RecordTypeId', 'BriefId', 'CampaignImageId', 'CampaignMemberRecordTypeId'];
const preservationProjection = [
  ...fields,
  ...relationships,
  'OwnerId',
  'StartDate',
  'EndDate',
  'CurrencyIsoCode',
  'ExpectedRevenue',
  'BudgetedCost',
  'ActualCost',
];
export type CampaignArtifact = { sourceId: string; fields: Record<string, unknown> };
export type CampaignSelection = {
  operation: 'export' | 'create' | 'update';
  projectRoot: string;
  targetOrg: string;
  expectedOrgId: string;
  apiVersion: string;
  recordId?: string;
  expectedName?: string;
  targetName?: string;
  expectUnchanged?: boolean;
  artifact?: CampaignArtifact;
  journalFile?: string;
};
export type CampaignSnapshot = Record<string, unknown> & { Id: string };
export type CampaignExportDiagnostics = {
  snapshot: 'complete' | 'incomplete';
  omittedFields: string[];
  associatedArtifacts: {
    status: 'complete' | 'incomplete' | 'blocked';
    reason: string;
    flows?: Array<{
      record: Record<string, unknown>;
      status: 'complete' | 'blocked';
      reason?: string;
      toolingDefinition?: Record<string, unknown>;
      toolingFlow?: Record<string, unknown>;
    }>;
  };
};
export type CampaignResult =
  | { operation: 'create' | 'update'; targetId: string; artifact: CampaignArtifact }
  | {
      operation: 'export';
      targetId: string;
      artifact: CampaignSnapshot;
      diagnostics: CampaignExportDiagnostics;
    };

function exportSnapshot(
  describe: Record<string, unknown>,
  record: Record<string, unknown>,
  id: string
): { artifact: CampaignSnapshot; diagnostics: CampaignExportDiagnostics } {
  if (
    describe.name !== 'Campaign' ||
    describe.queryable !== true ||
    !Array.isArray(describe.fields) ||
    !describe.fields.length ||
    !describe.fields.every(
      (field: unknown) =>
        object(field) &&
        typeof field.name === 'string' &&
        /^[A-Za-z][A-Za-z0-9_]*$/.test(field.name) &&
        field.name !== 'attributes' &&
        typeof field.type === 'string' &&
        field.type.length > 0
    )
  )
    throw new Error('Campaign export schema is unavailable or malformed');
  const names = (describe.fields as Array<{ name: string }>).map((field) => field.name).sort();
  if (!names.includes('Id') || new Set(names).size !== names.length)
    throw new Error('Campaign export schema lacks canonical Id or contains duplicate fields');
  if (!campaignId(record.Id) || record.Id !== id) throw new Error('Campaign export canonical identity mismatch');
  const omittedFields = names.filter((name) => !Object.hasOwn(record, name));
  const artifact: CampaignSnapshot = {
    Id: id,
    ...Object.fromEntries(
      names
        .filter((name) => name !== 'Id' && Object.hasOwn(record, name))
        .map((name) => [name, copySnapshotValue(record[name])])
    ),
  };
  return {
    artifact,
    diagnostics: {
      snapshot: omittedFields.length ? 'incomplete' : 'complete',
      omittedFields,
      associatedArtifacts: {
        status: 'blocked',
        reason:
          'Associated Flow and per-flow Segment discovery is not implemented in this flat-snapshot slice; this is not a full backup',
      },
    },
  };
}

function copySnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copySnapshotValue);
  if (object(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'attributes')
        .map(([key, entry]) => [key, copySnapshotValue(entry)])
    );
  return value;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function campaignId(value: unknown): value is string {
  return typeof value === 'string' && /^701[A-Za-z0-9]{15}$/.test(value);
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !/["'\\\r\n\t\0]/.test(value) &&
    !['true', 'false', 'null'].includes(value)
  );
}

function validateSelection(s: CampaignSelection): void {
  if (
    !['export', 'create', 'update'].includes(s.operation) ||
    !s.targetOrg.trim() ||
    s.targetOrg.startsWith('-') ||
    s.targetOrg.includes('\0') ||
    !/^00D[A-Za-z0-9]{15}$/.test(s.expectedOrgId) ||
    !/^\d{2,3}\.0$/.test(s.apiVersion)
  )
    throw new Error('Explicit operation, target org identity and API version are required');
  if (s.operation !== 'create' && !campaignId(s.recordId))
    throw new Error('Exact 18-character Campaign record ID required');
  const forbidden =
    s.operation === 'export'
      ? [s.artifact, s.targetName, s.expectedName, s.expectUnchanged, s.journalFile]
      : s.operation === 'create'
      ? [s.recordId, s.expectedName, s.expectUnchanged]
      : [s.targetName, s.journalFile];
  if (forbidden.some((value) => value !== undefined)) throw new Error('Unexpected Campaign operation inputs');
  validateMutationIdentity(s);
}
function validateMutationIdentity(s: CampaignSelection): void {
  if (s.operation === 'create' && (!text(s.targetName) || !s.journalFile))
    throw new Error('CREATE requires a fresh target-name and new journal-file');
  if (s.operation === 'update' && !text(s.expectedName)) throw new Error('UPDATE requires expected-name');
  if (s.expectUnchanged !== undefined && typeof s.expectUnchanged !== 'boolean')
    throw new Error('expect-unchanged must be boolean');
}
async function journalPath(projectRoot: string, declared: string): Promise<string> {
  if (!declared || declared.includes('\0') || isAbsolute(declared))
    throw new Error('journal-file must be a nonempty relative project path');
  const parts = declared.replaceAll('\\', '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error('journal-file must not contain dot or traversal segments');
  const root = await realpath(resolve(projectRoot));
  const target = resolve(root, declared);
  const relation = relative(root, target);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation))
    throw new Error('journal-file escapes the project root');
  const parent = await realpath(dirname(target));
  const canonicalRelation = relative(root, resolve(parent, basename(target)));
  if (canonicalRelation === '..' || canonicalRelation.startsWith(`..${sep}`) || isAbsolute(canonicalRelation))
    throw new Error('journal-file escapes the project root');
  return target;
}
function buildPayload(s: CampaignSelection): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (s.operation !== 'export') {
    if (
      !object(s.artifact) ||
      !campaignId(s.artifact.sourceId) ||
      !object(s.artifact.fields) ||
      !Object.keys(s.artifact.fields).length ||
      Object.keys(s.artifact).some((key) => !['sourceId', 'fields'].includes(key))
    )
      throw new Error('Expected nonempty Campaign artifact {sourceId, fields}');
    for (const [key, value] of Object.entries(s.artifact.fields)) {
      if (!fields.includes(key) || (s.operation === 'update' && key === 'Name'))
        throw new Error(
          `Unsupported Campaign field ${key}; relationships, custom fields and renaming are not supported`
        );
      if (key === 'IsActive' ? typeof value !== 'boolean' : !text(value))
        throw new Error(
          `Unsupported value for ${key}; null clearing, empty strings and complex quoting are not supported`
        );
      payload[key] = value;
    }
    if (s.operation === 'create') {
      if (!text(payload.Name) || payload.Name === s.targetName)
        throw new Error('CREATE requires source Name and a distinct target Name');
      payload.Name = s.targetName;
    }
  }
  return payload;
}
function validateFields(
  describe: Record<string, unknown>,
  payload: Record<string, unknown>,
  operation: string
): Array<Record<string, unknown>> {
  const writable = operation === 'create' ? 'createable' : 'updateable';
  if (describe[writable] !== true || !Array.isArray(describe.fields) || !describe.fields.every(object))
    throw new Error('Campaign target is not writable or describe is malformed');
  const definitions = describe.fields;
  for (const [key, value] of Object.entries(payload)) {
    const field = definitions.find((entry) => entry.name === key);
    if (field?.[writable] !== true) throw new Error(`Campaign field ${key} is not target-writable`);
    if (typeof value === 'string' && typeof field.length === 'number' && value.length > field.length)
      throw new Error(`Campaign field ${key} exceeds target length`);
    if (
      field.type === 'picklist' &&
      (!Array.isArray(field.picklistValues) ||
        !field.picklistValues.some((entry: unknown) => object(entry) && entry.active === true && entry.value === value))
    )
      throw new Error(`Campaign field ${key} is not an active target picklist value`);
  }
  return definitions;
}
function assertCreateRelationshipProjection(record: Record<string, unknown>): void {
  if (relationships.some((field) => !Object.hasOwn(record, field)))
    throw new Error('Campaign CREATE readback lacks required relationship projection; reconcile before retrying');
  if (relationships.some((field) => record[field] !== null))
    throw new Error('Campaign CREATE readback contains unsupported relationships; reconcile before retrying');
}

function saveId(saved: Record<string, unknown>, s: CampaignSelection): string {
  if (
    saved.success !== true ||
    !Array.isArray(saved.errors) ||
    saved.errors.length ||
    !campaignId(saved.id) ||
    (s.operation === 'update' && saved.id !== s.recordId)
  )
    throw new Error('Ambiguous Campaign mutation result; reconcile before retrying');
  return saved.id;
}
type CampaignRead = (args: string[]) => Promise<Record<string, unknown>>;
function validateFlowReference(record: Record<string, unknown>, selected: string[]): void {
  if (selected.some((field) => !Object.hasOwn(record, field)))
    throw new Error('FlowRecord projection is incomplete; missing is not null');
  if (typeof record.ApiName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(record.ApiName))
    throw new Error('FlowRecord API member identity is missing or malformed');
  if (
    record.SegmentId !== null &&
    (typeof record.SegmentId !== 'string' || !/^1sg[A-Za-z0-9]{15}$/.test(record.SegmentId))
  )
    throw new Error('FlowRecord SegmentId is empty or malformed; preserved without inference');
  for (const field of ['ActiveVersionId', 'LatestVersionId']) {
    if (
      Object.hasOwn(record, field) &&
      record[field] !== null &&
      (typeof record[field] !== 'string' || !/^10v[A-Za-z0-9]{15}$/.test(record[field]))
    )
      throw new Error('Core FlowRecordVersion identity is malformed; never a Tooling Flow identity');
  }
}
function validateToolingDefinition(definition: Record<string, unknown>, member: unknown): void {
  if (
    typeof definition.Id !== 'string' ||
    !/^300[A-Za-z0-9]{15}$/.test(definition.Id) ||
    definition.DeveloperName !== member
  )
    throw new Error('Tooling definition identity mismatch');
  for (const field of ['ActiveVersionId', 'LatestVersionId']) {
    if (
      !Object.hasOwn(definition, field) ||
      (definition[field] !== null &&
        (typeof definition[field] !== 'string' || !/^301[A-Za-z0-9]{15}$/.test(definition[field])))
    )
      throw new Error('Tooling version identity is missing or malformed');
  }
  if (definition.LatestVersionId === null)
    throw new Error('Tooling latest version is null; no version inferred from core active version');
}

/** Discover source-owned references only; native artifact retrieval and persistence are separate work. */
async function discoverAssociations(
  describe: Record<string, unknown>,
  campaign: string,
  call: CampaignRead
): Promise<CampaignExportDiagnostics['associatedArtifacts']> {
  const flows: NonNullable<CampaignExportDiagnostics['associatedArtifacts']['flows']> = [];
  const reason =
    'References only: native Flow/SegmentDefinition artifacts and Campaign association persistence are not exported; not a full backup';
  try {
    if (
      !Array.isArray(describe.childRelationships) ||
      describe.childRelationships.filter(
        (child: unknown) =>
          object(child) &&
          child.relationshipName === 'Flows' &&
          child.childSObject === 'FlowRecord' &&
          child.field === 'AssociatedRecordId'
      ).length !== 1
    )
      throw new Error('Campaign.Flows relationship schema is unavailable or ambiguous');
    const schema = async (name: string, required: string[], tooling = false): Promise<Set<string>> => {
      const value = await call(['sobject', 'describe', '--sobject', name, ...(tooling ? ['--use-tooling-api'] : [])]);
      if (
        value.name !== name ||
        value.queryable !== true ||
        !Array.isArray(value.fields) ||
        !value.fields.every(
          (field: unknown) =>
            object(field) && typeof field.name === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(field.name)
        )
      )
        throw new Error(`${name} query schema is unavailable or malformed`);
      const names = value.fields.map((field: Record<string, unknown>) => String(field.name));
      if (new Set(names).size !== names.length || required.some((field) => !names.includes(field)))
        throw new Error(`${name} query schema lacks required fields or is ambiguous`);
      return new Set(names);
    };
    const query = async (soql: string, tooling = false): Promise<Array<Record<string, unknown>>> => {
      const value = await call(['data', 'query', '--query', soql, ...(tooling ? ['--use-tooling-api'] : [])]);
      if (
        value.done !== true ||
        !Array.isArray(value.records) ||
        !Number.isSafeInteger(value.totalSize) ||
        value.totalSize !== value.records.length ||
        value.records.length > 100 ||
        !value.records.every(object)
      )
        throw new Error('Incomplete association query (completed count required; maximum 100 rows)');
      return value.records;
    };
    const required = ['Id', 'ApiName', 'AssociatedRecordId', 'SegmentId'];
    const names = await schema('FlowRecord', required);
    const selected = [...required, ...['ActiveVersionId', 'LatestVersionId'].filter((field) => names.has(field))];
    const records = await query(
      `SELECT ${selected.join(', ')} FROM FlowRecord WHERE AssociatedRecordId = '${campaign}' ORDER BY Id LIMIT 101`
    );
    const seen = new Set<string>();
    for (const record of records) {
      if (
        typeof record.Id !== 'string' ||
        !/^2aF[A-Za-z0-9]{15}$/.test(record.Id) ||
        seen.has(record.Id) ||
        record.AssociatedRecordId !== campaign
      )
        throw new Error('Ambiguous or mismatched FlowRecord association identity');
      seen.add(record.Id);
      flows.push({
        record: Object.fromEntries(
          selected.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]])
        ),
        status: 'blocked',
      });
    }
    if (!flows.length) return { status: 'complete', reason, flows };
    await schema('FlowDefinition', ['Id', 'DeveloperName', 'ActiveVersionId', 'LatestVersionId'], true);
    await schema('Flow', ['Id', 'DefinitionId', 'Metadata'], true);
    await flows.reduce(async (previous, entry) => {
      await previous;
      const flow = entry;
      try {
        const record = flow.record;
        validateFlowReference(record, selected);
        const definitions = await query(
          `SELECT Id, DeveloperName, ActiveVersionId, LatestVersionId FROM FlowDefinition WHERE DeveloperName = '${String(
            record.ApiName
          )}' LIMIT 2`,
          true
        );
        if (definitions.length !== 1) throw new Error('Tooling definition member correlation is absent or ambiguous');
        const definition = definitions[0];
        flow.toolingDefinition = definition;
        validateToolingDefinition(definition, record.ApiName);
        const versions = await query(
          `SELECT Id, DefinitionId, Metadata FROM Flow WHERE Id = '${String(definition.LatestVersionId)}' LIMIT 2`,
          true
        );
        if (
          versions.length !== 1 ||
          versions[0].Id !== definition.LatestVersionId ||
          versions[0].DefinitionId !== definition.Id ||
          !object(versions[0].Metadata)
        )
          throw new Error('Tooling latest Flow correlation is absent, ambiguous or incomplete');
        flow.toolingFlow = versions[0];
        const start = versions[0].Metadata.start;
        if (!object(start) || typeof start.triggerType !== 'string' || !start.triggerType.length)
          throw new Error('Tooling Flow start configuration is incomplete');
        if (
          start.triggerType === 'Segment' &&
          (!Object.hasOwn(start, 'segment') || typeof start.segment !== 'string' || !start.segment.length)
        )
          throw new Error('Tooling Flow segment selection is missing or empty');
        flow.status = 'complete';
      } catch (error) {
        flow.reason = String(error);
      }
    }, Promise.resolve());
    return { status: flows.every((flow) => flow.status === 'complete') ? 'complete' : 'incomplete', reason, flows };
  } catch (error) {
    return { status: flows.length ? 'incomplete' : 'blocked', reason: `${String(error)}; ${reason}`, flows };
  }
}

/** Describe-driven read snapshots; mutations retain the closed scalar configuration contract. */
export async function runCampaign(s: CampaignSelection, runner: CoreRunner = runCore): Promise<CampaignResult> {
  validateSelection(s);
  const payload = buildPayload(s);
  const cwd = resolve(s.projectRoot);
  const resolvedJournal = s.operation === 'create' ? await journalPath(cwd, s.journalFile!) : undefined;
  const call = async (args: string[]): Promise<Record<string, unknown>> => {
    const response = await runner([...args, '--target-org', s.targetOrg, '--api-version', s.apiVersion, '--json'], cwd);
    const envelope: unknown = JSON.parse(response.stdout);
    if (response.exitCode !== 0 || !object(envelope) || envelope.status !== 0 || !object(envelope.result))
      throw new Error(
        'Core Campaign command failed or returned malformed success; reconcile mutations before retrying'
      );
    return envelope.result;
  };
  const query = async (soql: string): Promise<Array<Record<string, unknown>>> => {
    const result = await call(['data', 'query', '--query', soql]);
    if (
      result.done !== true ||
      !Array.isArray(result.records) ||
      result.totalSize !== result.records.length ||
      !result.records.every(object)
    )
      throw new Error('Incomplete Campaign identity query');
    return result.records;
  };
  const orgs = await query('SELECT Id FROM Organization');
  if (orgs.length !== 1 || orgs[0].Id !== s.expectedOrgId) throw new Error('Target org identity mismatch');
  const get = async (id: string): Promise<Record<string, unknown>> => {
    const record = await call(['data', 'get', 'record', '--sobject', 'Campaign', '--record-id', id]);
    if (
      record.Id !== id ||
      !text(record.Name) ||
      fields.some(
        (field) =>
          !Object.hasOwn(record, field) ||
          (field === 'IsActive'
            ? typeof record[field] !== 'boolean'
            : record[field] !== null && typeof record[field] !== 'string')
      )
    )
      throw new Error('Missing or malformed Campaign target record');
    return record;
  };
  const artifact = (record: Record<string, unknown>): CampaignArtifact => ({
    sourceId: String(record.Id),
    fields: Object.fromEntries(fields.filter((field) => record[field] !== null).map((field) => [field, record[field]])),
  });
  const assertPreservationProjection = (record: Record<string, unknown>, stage: 'baseline' | 'readback'): void => {
    const missing = preservationProjection.filter((field) => !Object.hasOwn(record, field));
    if (missing.length)
      throw new Error(
        stage === 'baseline'
          ? 'Campaign UPDATE baseline lacks required preservation fields'
          : 'Campaign UPDATE readback lacks required preservation fields; reconcile before retrying'
      );
  };
  if (s.operation === 'export') {
    const describe = await call(['sobject', 'describe', '--sobject', 'Campaign']);
    // Validate the schema before reading; GET preserves compound values and present nulls.
    exportSnapshot(describe, { Id: s.recordId }, s.recordId!);
    const record = await call(['data', 'get', 'record', '--sobject', 'Campaign', '--record-id', s.recordId!]);
    const snapshot = exportSnapshot(describe, record, s.recordId!);
    snapshot.diagnostics.associatedArtifacts = await discoverAssociations(describe, s.recordId!, call);
    return { operation: s.operation, targetId: s.recordId!, ...snapshot };
  }
  const describe = await call(['sobject', 'describe', '--sobject', 'Campaign']);
  const definitions = validateFields(describe, payload, s.operation);
  let baseline: Record<string, unknown> | undefined;
  if (s.operation === 'update') {
    baseline = await get(s.recordId!);
    assertPreservationProjection(baseline, 'baseline');
    if (baseline.Name !== s.expectedName) throw new Error('Campaign target identity/name mismatch');
    if (s.expectUnchanged === true && Object.entries(payload).some(([key, value]) => baseline?.[key] !== value))
      throw new Error('Repeated unchanged Campaign UPDATE payload differs from the independent baseline');
  } else {
    if (
      definitions.some(
        (field) =>
          field.createable === true &&
          field.nillable === false &&
          field.defaultedOnCreate === false &&
          typeof field.name === 'string' &&
          !Object.hasOwn(payload, field.name)
      )
    )
      throw new Error('Campaign target requires unsupported or missing fields');
    const rows = await query(`SELECT Id FROM Campaign WHERE Name = '${String(payload.Name)}' LIMIT 1`);
    if (rows.length) throw new Error('Campaign target Name already exists; CREATE never upserts');
    await writeFile(
      resolvedJournal!,
      JSON.stringify({
        state: 'pending',
        sourceId: s.artifact!.sourceId,
        targetOrgId: s.expectedOrgId,
        targetName: payload.Name,
      }),
      { flag: 'wx', mode: 0o600 }
    );
  }
  const values = Object.entries(payload)
    .map(([key, value]) => `${key}=${typeof value === 'boolean' ? String(value) : `'${String(value)}'`}`)
    .join(' ');
  const targetId = saveId(
    await call([
      'data',
      s.operation,
      'record',
      '--sobject',
      'Campaign',
      ...(s.operation === 'update' ? ['--record-id', s.recordId!] : []),
      '--values',
      values,
    ]),
    s
  );
  if (s.operation === 'create')
    await writeFile(
      resolvedJournal!,
      JSON.stringify({
        state: 'created',
        sourceId: s.artifact!.sourceId,
        targetOrgId: s.expectedOrgId,
        targetId,
        targetName: payload.Name,
      }),
      { mode: 0o600 }
    );
  const after = await get(targetId);
  if (s.operation === 'create') assertCreateRelationshipProjection(after);
  for (const [key, value] of Object.entries(payload))
    if (after[key] !== value) throw new Error(`Campaign readback mismatch for ${key}; reconcile before retrying`);
  if (baseline) {
    assertPreservationProjection(after, 'readback');
    if (preservationProjection.some((key) => !Object.hasOwn(payload, key) && !Object.is(baseline[key], after[key])))
      throw new Error('Campaign UPDATE preservation failed; reconcile before retrying');
  }
  return { operation: s.operation, targetId, artifact: artifact(after) };
}
