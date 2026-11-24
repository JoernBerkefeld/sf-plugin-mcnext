import { unlink } from 'node:fs/promises';
import type { Connection } from '@salesforce/core';
import type { Item, Outcome } from '../envelope.js';
import { flowPaths, sidecarPathOf } from './file.js';
import { deleteFlowRecord, describeError, flowItem, readFlowRecords, type FlowRecordRow } from './link.js';

/** A flow to delete: its API name and the flow file it was selected from. */
export type FlowToRemove = { name: string; path?: string };

export type RemoveFlowsOptions = {
  flows: FlowToRemove[];
  /** Report what would be deleted; delete nothing. */
  preview: boolean;
  /** Folder that holds `mcnext/`. */
  projectDir: string;
  /** Leave the flow file and its sidecar where they are. */
  keepLocalFiles: boolean;
};

const STOPPED: ReadonlySet<Outcome> = new Set<Outcome>(['failed', 'blocked', 'unknown']);

/** Removes each flow file with its sidecar; a file that is not there is fine. Returns what could not be removed. */
async function removeLocalFiles(xmlPaths: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const path of xmlPaths.flatMap((xml) => [xml, sidecarPathOf(xml)])) {
    try {
      // eslint-disable-next-line no-await-in-loop -- a handful of files
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        problems.push(`${path} could not be removed: ${describeError(error)}`);
    }
  }
  return problems;
}

async function removeOne(
  connection: Connection,
  options: RemoveFlowsOptions,
  apiName: string,
  xmlPaths: readonly string[],
  record: FlowRecordRow | undefined
): Promise<Item> {
  const path = xmlPaths[0];
  if (!record) return flowItem(apiName, 'unchanged', { message: 'The org has no such flow.' });
  if (record.activeVersionId)
    return flowItem(apiName, 'blocked', {
      id: record.id,
      code: 'FLOW_ACTIVE',
      message:
        'The flow has an active version. Deactivate it in Salesforce first; an active flow is never deleted here.',
    });
  if (options.preview) return flowItem(apiName, 'would-delete', { id: record.id, path });

  const deleted = await deleteFlowRecord(connection, record.id);
  if (!deleted.ok)
    return deleted.answered
      ? flowItem(apiName, 'failed', { id: record.id, code: 'FLOW_DELETE_FAILED', message: deleted.message })
      : flowItem(apiName, 'unknown', {
          id: record.id,
          code: 'FLOW_DELETE_UNKNOWN',
          message: `No answer from Salesforce; the flow may or may not be deleted. ${deleted.message}`,
        });
  const item = flowItem(apiName, 'deleted', { id: record.id, path });
  if (options.keepLocalFiles) return item;
  // Only now, with the delete confirmed, are the local files removed.
  const problems = await removeLocalFiles(xmlPaths);
  return problems.length > 0 ? { ...item, message: problems.join(' ') } : item;
}

/**
 * Delete draft flows: the `FlowRecord` row (Salesforce removes the flow with it). After a
 * confirmed delete (`deleted`) the flow file the flow was selected from and its sidecar are
 * removed, or `mcnext/flows/<ApiName>.flow-meta.xml` for a flow given without a file, unless
 * `keepLocalFiles`. No other outcome touches a file. A flow with an active version is `blocked`;
 * a flow the org does not have is `unchanged`. With `preview` nothing is deleted and every flow is
 * checked. A real run stops at the first flow that is failed, blocked or unknown; the flows after
 * it are `not-attempted`. Nothing is thrown.
 */
export async function removeFlows(connection: Connection, options: RemoveFlowsOptions): Promise<Item[]> {
  const pathsOf = new Map<string, Set<string>>();
  for (const { name, path } of options.flows) {
    const paths = pathsOf.get(name) ?? new Set<string>();
    paths.add(path ?? flowPaths(options.projectDir, name).xml);
    pathsOf.set(name, paths);
  }
  const apiNames = [...pathsOf.keys()];
  let records: FlowRecordRow[];
  try {
    records = await readFlowRecords(connection, apiNames);
  } catch (error) {
    const message = `The flows of the org could not be read: ${describeError(error)}`;
    return apiNames.map((name) => flowItem(name, 'failed', { code: 'FLOW_READ_FAILED', message }));
  }
  const items: Item[] = [];
  let stopped = false;
  for (const [apiName, paths] of pathsOf) {
    if (stopped) items.push(flowItem(apiName, 'not-attempted', { path: [...paths][0] }));
    else {
      const record = records.find((candidate) => candidate.apiName === apiName);
      // One delete after the other.
      // eslint-disable-next-line no-await-in-loop -- sequential writes
      const item = await removeOne(connection, options, apiName, [...paths], record);
      items.push(item);
      stopped = !options.preview && STOPPED.has(item.outcome);
    }
  }
  return items;
}
