import type { Connection } from '@salesforce/core';

export type BusinessUnit = {
  id: string;
  developerName: string;
  label: string;
  /** API name of the business unit's data space, as used in `<dataSpace>` of a flow. */
  dataSpace: string | null;
  /** Record ID of that data space; null when the business unit has none. */
  dataSpaceId: string | null;
  /** API names of the business unit's CMS workspaces; null when the org cannot list them per business unit. */
  workspaces: string[] | null;
};

export type BusinessUnitListing = {
  businessUnitsEnabled: boolean;
  businessUnits: BusinessUnit[];
  warnings: string[];
};

export type TargetScope = { businessUnit: BusinessUnit; dataSpace: string; dataSpaceId: string; workspaces: string[] };

export type BusinessUnitFailureCode =
  | 'BUSINESS_UNITS_NOT_ENABLED'
  | 'BUSINESS_UNIT_NOT_FOUND'
  | 'BUSINESS_UNIT_READ_FAILED';

export type ResolvedBusinessUnit =
  | { ok: true; scope: TargetScope }
  | { ok: false; code: BusinessUnitFailureCode; message: string };

export type PickedWorkspace =
  | { ok: true; workspace: string }
  | { ok: false; code: 'WORKSPACE_REQUIRED'; message: string };

type Row = Record<string, unknown>;

// Guards the paging loop against an API that keeps answering; real orgs need one or two pages.
const PAGE_LIMIT = 1000;

// Label field of BusinessUnit and API-name field of DataSpace, first one the describe has.
const LABEL_FIELDS = ['MasterLabel', 'Label', 'Name'];
const DATA_SPACE_NAME_FIELDS = ['DataSpaceApiName', 'DeveloperName', 'Name'];

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

async function fieldNames(connection: Connection, sobject: string): Promise<Set<string>> {
  const description = await connection.describe(sobject);
  return new Set(description.fields.map((field) => field.name));
}

async function queryRows(connection: Connection, soql: string): Promise<Row[]> {
  const result = await connection.query<Row>(soql, { autoFetch: true });
  return result.records;
}

/** Data space ID → API name. Throws when the read fails. */
export async function readDataSpaceNames(connection: Connection): Promise<Map<string, string>> {
  const fields = await fieldNames(connection, 'DataSpace');
  const nameField = DATA_SPACE_NAME_FIELDS.find((field) => fields.has(field));
  if (!nameField) throw new Error('DataSpace has no name field in this org');
  const names = new Map<string, string>();
  for (const row of await queryRows(connection, `SELECT Id, ${nameField} FROM DataSpace`)) {
    const id = text(row, 'Id');
    const name = text(row, nameField);
    if (id && name) names.set(id, name);
  }
  return names;
}

type Workspaces = { apiNames: string[]; unnamed: number };

/** Every page of the CMS workspaces of one business unit. Only valid in an org with the feature. */
async function readWorkspaces(connection: Connection, businessUnitId: string): Promise<Workspaces> {
  const base = `/services/data/v${connection.getApiVersion()}/connect/cms/spaces`;
  const seen = new Set<string>();
  const apiNames: string[] = [];
  let unnamed = 0;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    // Pages depend on each other: the loop ends on the answer of the page before.
    // eslint-disable-next-line no-await-in-loop -- sequential paging
    const data = await connection.request<unknown>(
      `${base}?businessUnitId=${encodeURIComponent(businessUnitId)}&page=${page}`
    );
    const spaces = isRow(data) ? data.spaces : undefined;
    if (!Array.isArray(spaces) || !spaces.every((space) => isRow(space)))
      throw new Error(`The CMS workspace list of business unit ${businessUnitId} has no spaces on page ${page}`);
    let added = 0;
    for (const space of spaces) {
      const id = text(space, 'id');
      if (!id) throw new Error(`The CMS workspace list of business unit ${businessUnitId} has a space without an ID`);
      if (!seen.has(id)) {
        seen.add(id);
        added += 1;
        const apiName = text(space, 'apiName');
        if (apiName) apiNames.push(apiName);
        else unnamed += 1;
      }
    }
    if (spaces.length === 0 || added === 0 || (isRow(data) && data.nextPageUrl === null)) return { apiNames, unnamed };
  }
  throw new Error(`The CMS workspace list of business unit ${businessUnitId} did not end after ${PAGE_LIMIT} pages`);
}

/**
 * Business units of the org with their data space and CMS workspaces.
 *
 * The org uses business units when `Campaign` has a `BusinessUnitId` field. Without the feature
 * the workspace list ignores its business-unit filter, so `workspaces` is null there.
 *
 * @throws when Salesforce does not answer a read or answers in an unexpected shape.
 */
export async function readBusinessUnits(connection: Connection): Promise<BusinessUnitListing> {
  const businessUnitsEnabled = (await fieldNames(connection, 'Campaign')).has('BusinessUnitId');
  const unitFields = await fieldNames(connection, 'BusinessUnit');
  const labelField = LABEL_FIELDS.find((field) => unitFields.has(field));
  const select = ['Id', 'DeveloperName', ...(labelField ? [labelField] : []), 'DataSpaceId'].join(', ');
  const rows = await queryRows(connection, `SELECT ${select} FROM BusinessUnit ORDER BY DeveloperName`);
  const dataSpaceNames = await readDataSpaceNames(connection);

  const warnings: string[] = [];
  const businessUnits: BusinessUnit[] = [];
  for (const row of rows) {
    const id = text(row, 'Id');
    const developerName = text(row, 'DeveloperName');
    if (!id || !developerName) throw new Error('A BusinessUnit row has no Id or DeveloperName');
    const dataSpaceId = text(row, 'DataSpaceId');
    const dataSpace = (dataSpaceId && dataSpaceNames.get(dataSpaceId)) ?? null;
    if (!dataSpace) warnings.push(`Business unit ${developerName} has no readable data space.`);
    let workspaces: string[] | null = null;
    if (businessUnitsEnabled) {
      // One business unit after the other keeps the load on the org small.
      // eslint-disable-next-line no-await-in-loop -- sequential reads
      const read = await readWorkspaces(connection, id);
      workspaces = read.apiNames;
      if (read.unnamed > 0)
        warnings.push(
          `Business unit ${developerName} has ${read.unnamed} CMS workspace(s) without an API name; they are not listed.`
        );
    }
    businessUnits.push({
      id,
      developerName,
      label: (labelField && text(row, labelField)) ?? developerName,
      dataSpace,
      dataSpaceId,
      workspaces,
    });
  }
  if (!businessUnitsEnabled)
    warnings.push(
      'This org does not use business units: CMS workspaces cannot be listed per business unit here. ' +
        'Use sf cms list workspace for all workspaces of the org.'
    );
  return { businessUnitsEnabled, businessUnits, warnings };
}

/**
 * Target scope of `--business-unit`: the business unit, its data space and its CMS workspaces.
 * A refusal or a failed read is returned, not thrown.
 */
export async function resolveBusinessUnit(
  connection: Connection,
  developerName: string
): Promise<ResolvedBusinessUnit> {
  let listing: BusinessUnitListing;
  try {
    listing = await readBusinessUnits(connection);
  } catch (error) {
    return {
      ok: false,
      code: 'BUSINESS_UNIT_READ_FAILED',
      message: `The business units of this org could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!listing.businessUnitsEnabled)
    return {
      ok: false,
      code: 'BUSINESS_UNITS_NOT_ENABLED',
      message:
        'This org does not use business units, so --business-unit cannot be used. ' +
        'Use sf mcnext retrieve without --business-unit for campaigns and flows, ' +
        'sf data360 retrieve --dataspace for a data space and sf cms retrieve --workspace for a CMS workspace.',
    };
  const wanted = developerName.toLowerCase();
  const businessUnit = listing.businessUnits.find((unit) => unit.developerName.toLowerCase() === wanted);
  if (!businessUnit) {
    const names = listing.businessUnits.map((unit) => unit.developerName).join(', ');
    return {
      ok: false,
      code: 'BUSINESS_UNIT_NOT_FOUND',
      message: `No business unit ${developerName} in this org. Business units: ${names || 'none'}.`,
    };
  }
  if (!businessUnit.dataSpace || !businessUnit.dataSpaceId || !businessUnit.workspaces)
    return {
      ok: false,
      code: 'BUSINESS_UNIT_READ_FAILED',
      message: `The data space of business unit ${businessUnit.developerName} could not be read.`,
    };
  return {
    ok: true,
    scope: {
      businessUnit,
      dataSpace: businessUnit.dataSpace,
      dataSpaceId: businessUnit.dataSpaceId,
      workspaces: businessUnit.workspaces,
    },
  };
}

/**
 * CMS workspace of a copy into a business unit: `--workspace` wins; the only workspace of the
 * target; with several, the one named like the source workspace. Otherwise the user has to choose.
 */
export function pickWorkspace(targetWorkspaces: string[], sourceWorkspace: string, explicit?: string): PickedWorkspace {
  if (explicit) return { ok: true, workspace: explicit };
  if (targetWorkspaces.length === 1) return { ok: true, workspace: targetWorkspaces[0] };
  const wanted = sourceWorkspace.toLowerCase();
  const sameName = targetWorkspaces.find((workspace) => workspace.toLowerCase() === wanted);
  if (sameName) return { ok: true, workspace: sameName };
  return {
    ok: false,
    code: 'WORKSPACE_REQUIRED',
    message:
      targetWorkspaces.length === 0
        ? 'The target business unit has no CMS workspace. Name one with --workspace.'
        : `The target business unit has several CMS workspaces (${targetWorkspaces.join(', ')}) and none is named ` +
          `${sourceWorkspace}. Choose one with --workspace.`,
  };
}
