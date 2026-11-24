import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Connection } from '@salesforce/core';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { FLOW_XML_SUFFIX } from './file.js';

/**
 * One Flow through the Metadata API, in-process, with the library `sf project` uses. Each call
 * works in its own new folder under the OS temp directory and removes that folder again.
 * Neither function throws.
 */

export type FlowRetrieval =
  | { ok: true; xml: string; messages: string[] }
  | { ok: false; code: 'FLOW_NOT_FOUND' | 'FLOW_RETRIEVE_FAILED'; message: string; messages: string[] };

export type FlowDeployment = {
  /**
   * `unknown`: the request was sent and no final answer came back (network error or timeout), so
   * the flow may or may not be written. Never retried here.
   */
  status: 'succeeded' | 'failed' | 'unknown';
  /** Salesforce's answer when it answered: Succeeded, Failed, Canceled, … */
  requestStatus?: string;
  created?: boolean;
  /** What Salesforce says about a component it accepted. It reports missing settings this way. */
  messages: string[];
  /** Why a component was refused. */
  errors: string[];
};

const TEMP_PREFIX = 'mcnext-flow-';
const MARKER = '.mcnext-flow-run.json';

type Workspace = { folder: string; marker: string };

async function createWorkspace(): Promise<Workspace> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), TEMP_PREFIX)));
  const marker = `${JSON.stringify({ run: randomUUID() })}\n`;
  await writeFile(join(folder, MARKER), marker, { encoding: 'utf8', flag: 'wx' });
  return { folder, marker };
}

/** Removes the folder this module created, and nothing else: it must still carry this run's marker. */
async function removeWorkspace(workspace: Workspace): Promise<void> {
  try {
    const folder = await realpath(workspace.folder);
    const owned =
      folder === workspace.folder &&
      dirname(folder) === (await realpath(tmpdir())) &&
      basename(folder).startsWith(TEMP_PREFIX) &&
      (await readFile(join(folder, MARKER), 'utf8')) === workspace.marker;
    if (owned) await rm(folder, { recursive: true, force: true });
  } catch {
    // A folder that cannot be verified is left where it is.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function list<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Retrieve one flow as source-format XML. */
export async function retrieveFlow(connection: Connection, apiName: string): Promise<FlowRetrieval> {
  let workspace: Workspace | undefined;
  try {
    workspace = await createWorkspace();
    const retrieve = await new ComponentSet([{ fullName: apiName, type: 'Flow' }]).retrieve({
      usernameOrConnection: connection,
      output: workspace.folder,
      merge: false,
      format: 'source',
    });
    const result = await retrieve.pollStatus();
    const messages = list(result.response.messages).map((entry) => entry.problem);
    const file = result
      .getFileResponses()
      .map((response) => response.filePath)
      .find((path): path is string => typeof path === 'string' && path.endsWith(FLOW_XML_SUFFIX));
    if (!file) {
      return {
        ok: false,
        code: 'FLOW_NOT_FOUND',
        message: `Salesforce returned no flow ${apiName}.${messages.length > 0 ? ` ${messages.join(' ')}` : ''}`,
        messages,
      };
    }
    return { ok: true, xml: await readFile(file, 'utf8'), messages };
  } catch (error) {
    return {
      ok: false,
      code: 'FLOW_RETRIEVE_FAILED',
      message: `Flow ${apiName} could not be retrieved: ${describe(error)}`,
      messages: [],
    };
  } finally {
    if (workspace) await removeWorkspace(workspace);
  }
}

/** Deploy one flow file as it is. The status in the file is deployed as written. */
export async function deployFlow(
  connection: Connection,
  flow: { apiName: string; xml: string }
): Promise<FlowDeployment> {
  let workspace: Workspace | undefined;
  let sent = false;
  try {
    workspace = await createWorkspace();
    const folder = join(workspace.folder, 'flows');
    await mkdir(folder);
    await writeFile(join(folder, `${flow.apiName}${FLOW_XML_SUFFIX}`), flow.xml, 'utf8');
    const components = ComponentSet.fromSource(folder);
    if (components.size !== 1)
      return { status: 'failed', messages: [], errors: [`${flow.apiName} was not recognised as one Flow component.`] };
    sent = true;
    const deploy = await components.deploy({ usernameOrConnection: connection });
    const { response } = await deploy.pollStatus();
    const successes = list(response.details?.componentSuccesses).filter((entry) => entry.fullName === flow.apiName);
    const failures = list(response.details?.componentFailures);
    const errors = failures.map((entry) => entry.problem ?? `${entry.fullName} failed`);
    if (response.errorMessage) errors.push(response.errorMessage);
    return {
      status: response.success ? 'succeeded' : 'failed',
      requestStatus: String(response.status),
      created: successes.some((entry) => String(entry.created) === 'true'),
      messages: successes.flatMap((entry) => (entry.problem ? [entry.problem] : [])),
      errors,
    };
  } catch (error) {
    // Once the request is on its way, a missing answer says nothing about what Salesforce did.
    return { status: sent ? 'unknown' : 'failed', messages: [], errors: [describe(error)] };
  } finally {
    if (workspace) await removeWorkspace(workspace);
  }
}
