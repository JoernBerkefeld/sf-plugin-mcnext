import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runCore, type CoreRunner } from './flowCli.js';

const fields = ['Name', 'Type', 'Status', 'IsActive', 'Description'];
const relationships = ['ParentId', 'RecordTypeId', 'BriefId', 'CampaignImageId', 'CampaignMemberRecordTypeId'];
const preserved = [
  ...fields,
  ...relationships,
  'OwnerId',
  'StartDate',
  'EndDate',
  'CurrencyIsoCode',
  'ExpectedRevenue',
  'BudgetedCost',
  'ActualCost',
  'External_ID__c',
  'Stage',
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
  artifact?: CampaignArtifact;
  journalFile?: string;
};
export type CampaignResult = {
  operation: CampaignSelection['operation'];
  targetId: string;
  artifact: CampaignArtifact;
};

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
      ? [s.artifact, s.targetName, s.expectedName, s.journalFile]
      : s.operation === 'create'
      ? [s.recordId, s.expectedName]
      : [s.targetName, s.journalFile];
  if (forbidden.some((value) => value !== undefined)) throw new Error('Unexpected Campaign operation inputs');
  validateMutationIdentity(s);
}
function validateMutationIdentity(s: CampaignSelection): void {
  if (s.operation === 'create' && (!text(s.targetName) || !s.journalFile))
    throw new Error('CREATE requires a fresh target-name and new journal-file');
  if (s.operation === 'update' && !text(s.expectedName)) throw new Error('UPDATE requires expected-name');
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
/** Closed scalar configuration adapter. Relationships are deliberately unsupported, never inferred. */
export async function runCampaign(s: CampaignSelection, runner: CoreRunner = runCore): Promise<CampaignResult> {
  validateSelection(s);
  const payload = buildPayload(s);
  const cwd = resolve(s.projectRoot);
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
  if (s.operation === 'export') {
    const record = await get(s.recordId!);
    if (relationships.some((field) => record[field] !== null && record[field] !== undefined))
      throw new Error('Unsupported Campaign relationships; explicit target-local mapping is not implemented');
    return { operation: s.operation, targetId: s.recordId!, artifact: artifact(record) };
  }
  const describe = await call(['sobject', 'describe', '--sobject', 'Campaign']);
  const definitions = validateFields(describe, payload, s.operation);
  let baseline: Record<string, unknown> | undefined;
  if (s.operation === 'update') {
    baseline = await get(s.recordId!);
    if (baseline.Name !== s.expectedName) throw new Error('Campaign target identity/name mismatch');
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
      resolve(cwd, s.journalFile!),
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
      resolve(cwd, s.journalFile!),
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
  for (const [key, value] of Object.entries(payload))
    if (after[key] !== value) throw new Error(`Campaign readback mismatch for ${key}; reconcile before retrying`);
  if (baseline && preserved.some((key) => !Object.hasOwn(payload, key) && baseline[key] !== after[key]))
    throw new Error('Campaign UPDATE preservation failed; reconcile before retrying');
  return { operation: s.operation, targetId, artifact: artifact(after) };
}
