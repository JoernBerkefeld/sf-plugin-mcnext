import type { Connection } from '@salesforce/core';
import type { Item, Outcome } from '../envelope.js';

export type Row = Record<string, unknown>;

export type CampaignDescribe = {
  /** Every field of Campaign in this org. */
  all: Set<string>;
  /** The fields a campaign file holds under `fields`. */
  fileFields: string[];
  /** Relationship name of each lookup written by name; null when the org has no such field. */
  parent: string | null;
  businessUnit: string | null;
  brief: string | null;
};

export type Problem = { outcome: 'failed' | 'blocked' | 'unknown'; code: string; message: string };

const LOOKUPS = { ParentId: 'Parent', BusinessUnitId: 'BusinessUnit', BriefId: 'Brief' } as const;
// `Name` is the file's own `name`.
const NOT_IN_FIELDS = new Set(['Name', 'OwnerId', 'RecordTypeId', ...Object.keys(LOOKUPS)]);
const ID_PREFIX_LENGTH = 15;

export function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function soqlQuote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** 15- and 18-character forms of one record ID are equal. */
export function sameId(left: unknown, right: unknown): boolean {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    left.slice(0, ID_PREFIX_LENGTH) === right.slice(0, ID_PREFIX_LENGTH)
  );
}

export function campaignItem(
  name: string,
  outcome: Outcome,
  rest: Omit<Item, 'area' | 'type' | 'name' | 'outcome'>
): Item {
  const item: Item = { area: 'mcnext', type: 'campaign', name, outcome };
  for (const [key, value] of Object.entries(rest))
    if (value !== undefined && value !== '') Object.assign(item, { [key]: value });
  return item;
}

export function readFailure(error: unknown): Problem {
  return { outcome: 'failed', code: 'CAMPAIGN_READ_FAILED', message: messageOf(error) };
}

export async function describeCampaign(connection: Connection): Promise<CampaignDescribe> {
  const description = await connection.describe('Campaign');
  const relationship = (field: keyof typeof LOOKUPS): string | null => {
    const found = description.fields.find((candidate) => candidate.name === field);
    return found ? found.relationshipName ?? LOOKUPS[field] : null;
  };
  return {
    all: new Set(description.fields.map((field) => field.name)),
    fileFields: description.fields
      .filter((field) => (field.createable || field.updateable) && !NOT_IN_FIELDS.has(field.name))
      .map((field) => field.name),
    parent: relationship('ParentId'),
    businessUnit: relationship('BusinessUnitId'),
    brief: relationship('BriefId'),
  };
}

export async function queryRows(connection: Connection, soql: string): Promise<Row[]> {
  const result = await connection.query<Row>(soql, { autoFetch: true });
  return result.records;
}

/**
 * Where a campaign name is looked up: in one business unit (`businessUnitId`), among the campaigns
 * without a business unit (`null`), or in the whole org (`undefined`: an org without business
 * units, or a search across them).
 */
export type Bucket = { businessUnitId: string | null } | undefined;

/** Campaigns of exactly this name in the bucket (SOQL compares names without regard to case). */
export async function findCampaignRows(
  connection: Connection,
  name: string,
  select: string[],
  bucket?: Bucket
): Promise<Row[]> {
  const fields = [...new Set(['Id', 'Name', ...select])].join(', ');
  const scope = bucket
    ? ` AND BusinessUnitId = ${bucket.businessUnitId === null ? 'null' : soqlQuote(bucket.businessUnitId)}`
    : '';
  const rows = await queryRows(connection, `SELECT ${fields} FROM Campaign WHERE Name = ${soqlQuote(name)}${scope}`);
  return rows.filter((row) => row.Name === name);
}

/** ID of the business unit with this developer name; null when the org has none. */
export async function findBusinessUnitId(connection: Connection, developerName: string): Promise<string | null> {
  const rows = await queryRows(
    connection,
    `SELECT Id FROM BusinessUnit WHERE DeveloperName = ${soqlQuote(developerName)}`
  );
  const id = rows[0]?.Id;
  return typeof id === 'string' ? id : null;
}

/** How a message names a bucket. */
export function bucketText(businessUnit: string | null | undefined): string {
  return businessUnit ? `in business unit ${businessUnit}` : 'without a business unit';
}

/**
 * A write that threw. Salesforce's own refusal carries an `errorCode`; anything else (network
 * error, timeout, a gateway answer) leaves open whether the write happened.
 */
function thrownWrite(error: unknown): Problem {
  const errorCode = isRow(error) && typeof error.errorCode === 'string' ? error.errorCode : null;
  if (errorCode && !/^ERROR_HTTP_5\d\d$/u.test(errorCode))
    return { outcome: 'failed', code: errorCode, message: messageOf(error) };
  return {
    outcome: 'unknown',
    code: 'CAMPAIGN_WRITE_UNKNOWN',
    message: `Salesforce did not answer the write, so it is not known whether it happened: ${messageOf(error)}`,
  };
}

function refusedWrite(result: Row): Problem {
  const errors = (Array.isArray(result.errors) ? result.errors : []).filter((error): error is Row => isRow(error));
  const first = errors[0] ?? {};
  const code = [first.statusCode, first.errorCode].find((value): value is string => typeof value === 'string');
  const messages = errors
    .map((error) => error.message)
    .filter((message): message is string => typeof message === 'string');
  return {
    outcome: 'failed',
    code: code ?? 'CAMPAIGN_WRITE_FAILED',
    message: messages.join(' ') || 'Salesforce refused the write without a message.',
  };
}

/** One write, sent once. */
export async function writeOnce(
  send: () => Promise<unknown>
): Promise<{ ok: true; id?: string } | (Problem & { ok: false })> {
  let result: unknown;
  try {
    result = await send();
  } catch (error) {
    return { ok: false, ...thrownWrite(error) };
  }
  if (isRow(result) && result.success === false) return { ok: false, ...refusedWrite(result) };
  return { ok: true, id: isRow(result) && typeof result.id === 'string' ? result.id : undefined };
}
