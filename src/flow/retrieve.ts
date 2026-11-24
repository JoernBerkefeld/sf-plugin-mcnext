import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Connection } from '@salesforce/core';
import { readDataSpaceNames } from '../business-units.js';
import type { Item } from '../envelope.js';
import { listSegments, parseFlowContentReference, type SegmentRow } from '../libraries.js';
import {
  flowPaths,
  getDataSpace,
  getStartSegment,
  listContentIds,
  serializeSidecar,
  setStartSegment,
  type FlowNeed,
  type FlowSidecar,
} from './file.js';
import {
  codeOf,
  describeError,
  flowItem,
  readCampaignNames,
  readFlowRecords,
  readMarketingFlowRecords,
  sameId,
  type FlowRecordRow,
} from './link.js';
import { retrieveFlow } from './metadata.js';

export type RetrieveFlowsOptions = {
  /** Flows by API name. Without it: every flow that has a data space (the marketing flows). */
  apiNames?: string[];
  /** Only flows of this data space (API name). Without `dataSpaceId` its record ID is read from the org. */
  dataSpace?: string;
  /** Record ID of the data space the flows are limited to; `dataSpace` then only names it in messages. */
  dataSpaceId?: string;
  /** Folder the `mcnext/` folder is written to. */
  outputDir: string;
};

export type RetrieveFlowsDeps = {
  retrieveFlow: typeof retrieveFlow;
  listSegments: typeof listSegments;
  readDataSpaceNames: typeof readDataSpaceNames;
};

const DEFAULT_DEPS: RetrieveFlowsDeps = { retrieveFlow, listSegments, readDataSpaceNames };

const CAMPAIGN_ID_PREFIX = '701';
const SEGMENT_ID = /^1sg[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** Whether the text of `<start><segment>` is a `MarketSegment` record ID rather than an API name. */
export function isSegmentId(value: string): boolean {
  return SEGMENT_ID.test(value);
}

/** The content items a flow file sends, as needs. A value that is no content reference is left out. */
export function contentNeeds(xml: string): FlowNeed[] {
  const needs = new Map<string, FlowNeed>();
  for (const contentId of listContentIds(xml)) {
    try {
      const { workspaceApiName, type, apiName } = parseFlowContentReference(contentId);
      needs.set(`${workspaceApiName}/${type}/${apiName}`, {
        kind: 'content',
        type,
        apiName,
        workspace: workspaceApiName,
      });
    } catch {
      // Not a workspace reference (a content key, a variable): nothing to check before a deploy.
    }
  }
  return [...needs.values()];
}

type Selection = {
  rows: FlowRecordRow[];
  missing: string[];
  /** Named flows the org has, but in another data space than the one asked for. */
  outside: FlowRecordRow[];
  /** The data space asked for by name is not one of the org. */
  unknownDataSpace?: string;
};

/**
 * Record ID of the data space the flows are limited to; undefined without a limit, null when the
 * org has no data space of that API name. A flow is matched by `DataSpaceId`, never by a name.
 */
async function scopeIdOf(
  connection: Connection,
  options: RetrieveFlowsOptions,
  deps: RetrieveFlowsDeps
): Promise<string | null | undefined> {
  if (options.dataSpaceId) return options.dataSpaceId;
  if (options.dataSpace === undefined) return undefined;
  const wanted = options.dataSpace.toLowerCase();
  for (const [id, apiName] of await deps.readDataSpaceNames(connection)) {
    if (apiName.toLowerCase() === wanted) return id;
  }
  return null;
}

async function select(
  connection: Connection,
  options: RetrieveFlowsOptions,
  deps: RetrieveFlowsDeps
): Promise<Selection> {
  const scopeId = await scopeIdOf(connection, options, deps);
  if (scopeId === null) return { rows: [], missing: [], outside: [], unknownDataSpace: options.dataSpace };
  const inScope = (row: FlowRecordRow): boolean => scopeId === undefined || sameId(row.dataSpaceId, scopeId);
  if (!options.apiNames)
    return { rows: (await readMarketingFlowRecords(connection)).filter(inScope), missing: [], outside: [] };
  const apiNames = [...new Set(options.apiNames)];
  const rows = await readFlowRecords(connection, apiNames);
  const found = new Set(rows.map((row) => row.apiName));
  const named = apiNames.flatMap((name) => rows.find((row) => row.apiName === name) ?? []);
  return {
    rows: named.filter(inScope),
    missing: apiNames.filter((name) => !found.has(name)),
    outside: named.filter((row) => !inScope(row)),
  };
}

/**
 * Write flows to `<outputDir>/mcnext/flows/`: the flow file with the segment as API name, and the
 * sidecar with the campaign and the needs. Existing files are replaced. A flow that cannot be
 * retrieved is an item with outcome `failed`; nothing is thrown.
 */
export async function retrieveFlows(
  connection: Connection,
  options: RetrieveFlowsOptions,
  deps: RetrieveFlowsDeps = DEFAULT_DEPS
): Promise<Item[]> {
  let selection: Selection;
  let campaigns: Map<string, string>;
  try {
    selection = await select(connection, options, deps);
    const campaignIds = selection.rows.flatMap((row) =>
      row.associatedRecordId?.startsWith(CAMPAIGN_ID_PREFIX) ? [row.associatedRecordId] : []
    );
    campaigns = await readCampaignNames(connection, [...new Set(campaignIds)]);
  } catch (error) {
    const message = `The flows of the org could not be read: ${describeError(error)}`;
    return (options.apiNames ?? ['*']).map((name) => flowItem(name, 'failed', { code: 'FLOW_READ_FAILED', message }));
  }

  if (selection.unknownDataSpace !== undefined) {
    const message = `No data space ${selection.unknownDataSpace} in this org.`;
    return (options.apiNames ?? ['*']).map((name) =>
      flowItem(name, 'failed', { code: 'DATA_SPACE_NOT_FOUND', message })
    );
  }

  const items = selection.missing.map((name) =>
    flowItem(name, 'failed', { code: 'FLOW_NOT_FOUND', message: `No flow ${name} in this org.` })
  );
  const scopeName = options.dataSpace ?? options.dataSpaceId ?? '';
  items.push(
    ...selection.outside.map((row) =>
      flowItem(row.apiName, 'failed', {
        id: row.id,
        code: 'FLOW_OTHER_DATASPACE',
        message: `Flow ${row.apiName} exists, but not in data space ${scopeName}. It was not retrieved.`,
      })
    )
  );
  const segmentsOf = new Map<string, Promise<SegmentRow[]>>();
  for (const row of selection.rows) {
    // One flow after the other: each retrieve is its own Metadata API request.
    // eslint-disable-next-line no-await-in-loop -- sequential retrieves
    items.push(await retrieveOne(connection, options.outputDir, row, campaigns, segmentsOf, deps));
  }
  return items;
}

async function retrieveOne(
  connection: Connection,
  outputDir: string,
  row: FlowRecordRow,
  campaigns: Map<string, string>,
  segmentsOf: Map<string, Promise<SegmentRow[]>>,
  deps: RetrieveFlowsDeps
): Promise<Item> {
  const name = row.apiName;
  const retrieved = await deps.retrieveFlow(connection, name);
  if (!retrieved.ok) return flowItem(name, 'failed', { id: row.id, code: retrieved.code, message: retrieved.message });
  const notes: string[] = [...retrieved.messages];
  const needs: FlowNeed[] = [];
  let xml = retrieved.xml;
  try {
    const dataSpace = getDataSpace(xml);
    const segment = getStartSegment(xml);
    if (segment && isSegmentId(segment)) {
      if (dataSpace) {
        if (!segmentsOf.has(dataSpace)) segmentsOf.set(dataSpace, deps.listSegments(connection, { dataSpace }));
        const segments = await (segmentsOf.get(dataSpace) as Promise<SegmentRow[]>);
        const match = segments.find((candidate) => candidate.marketSegmentId.slice(0, 15) === segment.slice(0, 15));
        if (match) {
          xml = setStartSegment(xml, match.apiName);
          needs.push({ kind: 'segment', name: match.apiName, dataSpace });
        } else {
          notes.push(
            `Segment ${segment} is not a segment of data space ${dataSpace}; the file keeps the record ID, which no other org knows.`
          );
        }
      } else {
        notes.push(
          `The flow has no data space, so segment ${segment} could not be named; the file keeps the record ID.`
        );
      }
    } else if (segment && dataSpace) {
      needs.push({ kind: 'segment', name: segment, dataSpace });
    }
    needs.push(...contentNeeds(xml));
  } catch (error) {
    return flowItem(name, 'failed', {
      id: row.id,
      code: codeOf(error) ?? 'FLOW_RETRIEVE_FAILED',
      message: `Flow ${name} was read but could not be prepared: ${describeError(error)}`,
    });
  }

  const campaign = row.associatedRecordId ? campaigns.get(row.associatedRecordId.slice(0, 15)) : undefined;
  const sidecar: FlowSidecar = { ...(campaign ? { campaign: { name: campaign } } : {}), needs };
  const paths = flowPaths(outputDir, name);
  try {
    await mkdir(dirname(paths.xml), { recursive: true });
    await writeFile(paths.xml, xml, 'utf8');
    await writeFile(paths.sidecar, serializeSidecar(sidecar), 'utf8');
  } catch (error) {
    return flowItem(name, 'failed', {
      id: row.id,
      path: paths.xml,
      code: 'FLOW_WRITE_FAILED',
      message: `The files of flow ${name} could not be written: ${describeError(error)}`,
    });
  }
  return flowItem(name, 'retrieved', {
    id: row.id,
    path: paths.xml,
    ...(notes.length > 0 ? { message: notes.join(' ') } : {}),
  });
}
