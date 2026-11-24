import type { Connection } from '@salesforce/core';
import { readDataSpaceNames } from '../business-units.js';
import type { Item, Outcome } from '../envelope.js';

/**
 * `FlowRecord`: the row Salesforce keeps per flow. It carries the campaign link
 * (`AssociatedRecordId`), and deleting it deletes a draft flow.
 */

export type FlowRecordRow = {
  id: string;
  apiName: string;
  /** Null on a flow that is not a marketing flow. */
  dataSpaceId: string | null;
  associatedRecordId: string | null;
  activeVersionId: string | null;
};

/** Result of one write. `answered: false`: no answer from Salesforce, so the write may have happened. */
export type WriteResult = { ok: true } | { ok: false; answered: boolean; message: string };

type Row = Record<string, unknown>;

const FIELDS = 'Id, ApiName, DataSpaceId, AssociatedRecordId, ActiveVersionId';
// Keeps one SOQL statement well below the length limit of a query URL.
const NAMES_PER_QUERY = 100;

export function flowItem(
  name: string,
  outcome: Outcome,
  more: Omit<Item, 'area' | 'type' | 'name' | 'outcome'> = {}
): Item {
  return { area: 'mcnext', type: 'flow', name, outcome, ...more };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `.code` of an error the libraries throw. */
export function codeOf(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

export function soqlText(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** Whether two record IDs are the same record, in their 15- or 18-character form. */
export function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && (a as string).slice(0, 15) === (b as string).slice(0, 15);
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function toRow(row: Row): FlowRecordRow | undefined {
  const id = text(row, 'Id');
  const apiName = text(row, 'ApiName');
  if (!id || !apiName) return undefined;
  return {
    id,
    apiName,
    dataSpaceId: text(row, 'DataSpaceId'),
    associatedRecordId: text(row, 'AssociatedRecordId'),
    activeVersionId: text(row, 'ActiveVersionId'),
  };
}

async function query(connection: Connection, soql: string): Promise<Row[]> {
  return (await connection.query<Row>(soql, { autoFetch: true })).records;
}

/** Every flow of the org that has a data space: the marketing flows. Throws when the read fails. */
export async function readMarketingFlowRecords(connection: Connection): Promise<FlowRecordRow[]> {
  const rows = await query(connection, `SELECT ${FIELDS} FROM FlowRecord WHERE DataSpaceId != null ORDER BY ApiName`);
  return rows.flatMap((row) => toRow(row) ?? []);
}

/** The rows of the named flows; a flow the org does not have is not in the result. Throws when the read fails. */
export async function readFlowRecords(connection: Connection, apiNames: readonly string[]): Promise<FlowRecordRow[]> {
  const found: FlowRecordRow[] = [];
  for (let from = 0; from < apiNames.length; from += NAMES_PER_QUERY) {
    const names = apiNames.slice(from, from + NAMES_PER_QUERY).map((name) => soqlText(name));
    // One statement after the other keeps the load on the org small.
    // eslint-disable-next-line no-await-in-loop -- sequential reads
    const rows = await query(connection, `SELECT ${FIELDS} FROM FlowRecord WHERE ApiName IN (${names.join(', ')})`);
    found.push(...rows.flatMap((row) => toRow(row) ?? []));
  }
  // SOQL compares without regard to case; a flow API name is matched exactly.
  const wanted = new Set(apiNames);
  return found.filter((row) => wanted.has(row.apiName));
}

export async function findFlowRecord(connection: Connection, apiName: string): Promise<FlowRecordRow | undefined> {
  return (await readFlowRecords(connection, [apiName]))[0];
}

/** Name of every campaign among the IDs. Throws when the read fails. */
export async function readCampaignNames(connection: Connection, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let from = 0; from < ids.length; from += NAMES_PER_QUERY) {
    const chunk = ids.slice(from, from + NAMES_PER_QUERY).map((id) => soqlText(id));
    // eslint-disable-next-line no-await-in-loop -- sequential reads
    for (const row of await query(connection, `SELECT Id, Name FROM Campaign WHERE Id IN (${chunk.join(', ')})`)) {
      const id = text(row, 'Id');
      const name = text(row, 'Name');
      if (id && name) names.set(id.slice(0, 15), name);
    }
  }
  return names;
}

/**
 * Where the campaign of a flow can be. `enabled: false`: the org has no business units, a campaign
 * is found by its name alone. Otherwise `businessUnits` own the flow's data space (one, as a rule;
 * none when the data space belongs to no business unit).
 */
export type CampaignScope = { enabled: boolean; businessUnits: Array<{ id: string; developerName: string }> };

/** The business unit a flow of this data space belongs to. Throws when a read fails. */
export async function readCampaignScope(connection: Connection, dataSpace: string | undefined): Promise<CampaignScope> {
  const description = await connection.describe('Campaign');
  if (!description.fields.some((field) => field.name === 'BusinessUnitId'))
    return { enabled: false, businessUnits: [] };
  if (!dataSpace) return { enabled: true, businessUnits: [] };
  const wanted = dataSpace.toLowerCase();
  const dataSpaceIds = [...(await readDataSpaceNames(connection))]
    .filter(([, name]) => name.toLowerCase() === wanted)
    .map(([id]) => soqlText(id));
  if (dataSpaceIds.length === 0) return { enabled: true, businessUnits: [] };
  const rows = await query(
    connection,
    `SELECT Id, DeveloperName FROM BusinessUnit WHERE DataSpaceId IN (${dataSpaceIds.join(', ')})`
  );
  return {
    enabled: true,
    businessUnits: rows.flatMap((row) => {
      const id = text(row, 'Id');
      const developerName = text(row, 'DeveloperName');
      return id && developerName ? [{ id, developerName }] : [];
    }),
  };
}

/**
 * IDs of the campaigns with exactly this name: of these business units, of none (`null`), or of
 * the whole org (no `businessUnitIds`). Throws when the read fails.
 */
export async function findCampaignIds(
  connection: Connection,
  name: string,
  businessUnitIds?: readonly string[] | null
): Promise<string[]> {
  const scope =
    businessUnitIds === undefined
      ? ''
      : businessUnitIds === null
      ? ' AND BusinessUnitId = null'
      : ` AND BusinessUnitId IN (${businessUnitIds.map((id) => soqlText(id)).join(', ')})`;
  const rows = await query(connection, `SELECT Id, Name FROM Campaign WHERE Name = ${soqlText(name)}${scope}`);
  // SOQL compares without regard to case; the sidecar names the campaign exactly.
  return rows.filter((row) => row.Name === name).flatMap((row) => text(row, 'Id') ?? []);
}

async function write(connection: Connection, method: 'PATCH' | 'DELETE', id: string, body?: Row): Promise<WriteResult> {
  try {
    await connection.request({
      method,
      url: `/services/data/v${connection.getApiVersion()}/sobjects/FlowRecord/${id}`,
      ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    });
    return { ok: true };
  } catch (error) {
    // Salesforce's refusals carry an errorCode; a network error or a timeout does not.
    const answered = typeof (error as { errorCode?: unknown } | null)?.errorCode === 'string';
    return { ok: false, answered, message: describeError(error) };
  }
}

/** Attach the flow to a campaign. Sent once, never retried. */
export function setAssociatedRecord(
  connection: Connection,
  flowRecordId: string,
  campaignId: string
): Promise<WriteResult> {
  return write(connection, 'PATCH', flowRecordId, { AssociatedRecordId: campaignId });
}

/** Delete the flow with all its versions. Sent once, never retried. */
export function deleteFlowRecord(connection: Connection, flowRecordId: string): Promise<WriteResult> {
  return write(connection, 'DELETE', flowRecordId);
}
