import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Connection } from '@salesforce/core';
import { CAMPAIGN_FILE_SUFFIX, campaignFilesOf } from '../campaign/file.js';
import { statusOf, type Area, type Envelope, type Item, type Outcome, type Status } from '../envelope.js';
import { FLOW_FOLDER, FLOW_SIDECAR_SUFFIX, FLOW_XML_SUFFIX, flowPaths } from '../flow/file.js';
import type { CmsDiagnostic, CmsResult } from '../libraries.js';
import {
  isSelectorError,
  parseMetadataSelector,
  parsePathSelector,
  type MetadataSelector,
  type PathSelector,
} from '../selectors.js';

const PROBLEM: ReadonlySet<Outcome> = new Set<Outcome>(['failed', 'blocked', 'unknown']);

export type Selection = { metadata: MetadataSelector[]; paths: PathSelector[] };

/** A check that ends the run before the org is touched. */
export type Refusal = { ok: false; code: string; message: string; area?: Area };

/** What one phase of a run produced. */
export type Phase = { items: Item[]; cms: Array<CmsResult<unknown>>; codes: Status[] };

/** The campaigns and flows a deploy or delete names. */
export type McnextSelection = {
  /** `-m campaign:Name`: the files named after it, in `mcnext/campaigns` and its business unit folders. */
  campaignNames: string[];
  /** Campaign files named by a bare `-m campaign` or by `-d`. */
  campaignFiles: string[];
  /** Flow files (`<ApiName>.flow-meta.xml`) of `-m flow`, `-m flow:ApiName` and `-d`. */
  flowFiles: string[];
};

/** The CMS selectors of one workspace: one `sf-plugin-cms` call. */
export type CmsGroup = { workspace: string; metadata: string[]; sourceDirs: string[] };

export function newPhase(): Phase {
  return { items: [], cms: [], codes: [] };
}

export function isProblem(item: Item): boolean {
  return PROBLEM.has(item.outcome);
}

export function hasProblem(items: readonly Item[]): boolean {
  return items.some(isProblem);
}

export function orgIdOf(connection: Connection): string {
  return connection.getAuthInfoFields().orgId ?? '';
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function codeOf(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** The run ended with errors before anything was written. */
export function refused(envelope: Envelope, errors: Envelope['errors']): Envelope {
  return { ...envelope, status: 1, errors: [...envelope.errors, ...errors] };
}

/** Ends the run with one error; nothing was written. */
export function refuse(envelope: Envelope, code: string, message: string, area?: Area): Envelope {
  return refused(envelope, [{ code, message, ...(area ? { area } : {}) }]);
}

/** The envelope with its status, from the items and the other plugins' exit codes. */
export function finish(envelope: Envelope, codes: readonly Status[]): Envelope {
  const status = statusOf(envelope.items, codes);
  // An error without an item or a phase code is still a failed run.
  return { ...envelope, status: status === 0 && envelope.errors.length > 0 ? 1 : status };
}

/** The same components, reported as not reached by a run that stopped before them. */
export function notAttempted(items: readonly Item[]): Item[] {
  return items.map(({ area, type, name, path }) => ({
    area,
    type,
    name,
    outcome: 'not-attempted',
    ...(path ? { path } : {}),
  }));
}

export function selectorText(selector: MetadataSelector): string {
  return selector.name === undefined ? selector.type : `${selector.type}:${selector.name}`;
}

/** Parses `-m` and `-d`. Every invalid value is reported; then there is no selection. */
export function parseSelection(
  metadata: readonly string[] | undefined,
  sourceDirs: readonly string[] | undefined,
  projectDir: string
): { ok: true; selection: Selection } | { ok: false; errors: Envelope['errors'] } {
  const selection: Selection = { metadata: [], paths: [] };
  const errors: Envelope['errors'] = [];
  for (const raw of metadata ?? []) {
    const parsed = parseMetadataSelector(raw);
    if (isSelectorError(parsed)) errors.push({ code: parsed.code, message: parsed.message });
    else selection.metadata.push(parsed);
  }
  for (const raw of sourceDirs ?? []) {
    const parsed = parsePathSelector(raw, projectDir);
    if (isSelectorError(parsed)) errors.push({ code: parsed.code, message: parsed.message });
    else selection.paths.push(parsed);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, selection };
}

export function selectsArea(selection: Selection, area: Area): boolean {
  return [...selection.metadata, ...selection.paths].some((selector) => selector.area === area);
}

function isMissing(error: unknown): boolean {
  return codeOf(error) === 'ENOENT';
}

/** Files of a folder and its subfolders; none when the folder does not exist. */
async function filesBelow(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(folder, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function subfolders(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/**
 * The campaigns and flows of `-m` and `-d`, from the files of the project folder. A bare type is
 * every file of that type in the project; for campaigns: those in `mcnext/campaigns` and in its
 * business unit folders. Nothing is read from the org.
 */
export async function selectMcnext(
  selection: Selection,
  projectDir: string
): Promise<{ ok: true; selected: McnextSelection } | Refusal> {
  const campaignNames = new Set<string>();
  const campaignFiles = new Set<string>();
  const flowFiles = new Set<string>();
  const addFile = (file: string): boolean => {
    if (file.endsWith(CAMPAIGN_FILE_SUFFIX)) campaignFiles.add(file);
    else if (file.endsWith(FLOW_XML_SUFFIX)) flowFiles.add(file);
    else if (file.endsWith(FLOW_SIDECAR_SUFFIX))
      flowFiles.add(`${file.slice(0, -FLOW_SIDECAR_SUFFIX.length)}${FLOW_XML_SUFFIX}`);
    else return false;
    return true;
  };

  for (const selector of selection.metadata.filter((candidate) => candidate.area === 'mcnext')) {
    if (selector.type === 'campaign' && selector.name !== undefined) campaignNames.add(selector.name);
    else if (selector.type === 'flow' && selector.name !== undefined)
      flowFiles.add(flowPaths(projectDir, selector.name).xml);
    else if (selector.type === 'campaign') {
      // A handful of selectors; each reads one folder.
      // eslint-disable-next-line no-await-in-loop -- sequential reads
      for (const file of await campaignFilesOf(projectDir)) campaignFiles.add(file);
    } else {
      // eslint-disable-next-line no-await-in-loop -- sequential reads
      for (const file of await filesBelow(join(projectDir, FLOW_FOLDER))) {
        if (file.endsWith(FLOW_XML_SUFFIX)) addFile(file);
      }
    }
  }

  for (const selector of selection.paths.filter((candidate) => candidate.area === 'mcnext')) {
    const target = resolve(projectDir, selector.path);
    let isFolder: boolean;
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential reads
      isFolder = (await stat(target)).isDirectory();
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { ok: false, code: 'SOURCE_NOT_FOUND', message: `${selector.raw} does not exist.`, area: 'mcnext' };
    }
    if (isFolder) {
      // eslint-disable-next-line no-await-in-loop -- sequential reads
      for (const file of await filesBelow(target)) addFile(file);
    } else if (!addFile(target)) {
      return {
        ok: false,
        code: 'INVALID_SOURCE_PATH',
        message:
          `${selector.raw} is neither a campaign file (${CAMPAIGN_FILE_SUFFIX}) nor a flow file ` +
          `(${FLOW_XML_SUFFIX}, ${FLOW_SIDECAR_SUFFIX}).`,
        area: 'mcnext',
      };
    }
  }
  return {
    ok: true,
    selected: { campaignNames: [...campaignNames], campaignFiles: [...campaignFiles], flowFiles: [...flowFiles] },
  };
}

/** Workspace folders `cms/<workspace>/` that hold the component (or, for a bare type, its type folder). */
async function workspacesHolding(projectDir: string, selector: MetadataSelector): Promise<string[]> {
  const found: string[] = [];
  for (const workspace of await subfolders(join(projectDir, 'cms'))) {
    // eslint-disable-next-line no-await-in-loop -- sequential reads
    const types = await subfolders(join(projectDir, 'cms', workspace));
    if (types.includes(selector.type)) {
      // eslint-disable-next-line no-await-in-loop -- sequential reads
      const names = await readdir(join(projectDir, 'cms', workspace, selector.type));
      if (selector.name === undefined || names.some((name) => name.startsWith(`${selector.name as string}.`)))
        found.push(workspace);
    }
  }
  return found;
}

/**
 * The CMS selectors, one group per workspace: `--workspace`; else the `cms/<workspace>/` folder of
 * a `-d` path; else, for `-m`, the one workspace folder of the project that holds the component.
 * A selector whose workspace is not clear that way is refused.
 */
export async function groupCms(
  selection: Selection,
  projectDir: string,
  explicitWorkspace: string | undefined
): Promise<{ ok: true; groups: CmsGroup[] } | Refusal> {
  const metadata = selection.metadata.filter((selector) => selector.area === 'cms');
  const paths = selection.paths.filter((selector) => selector.area === 'cms');
  if (metadata.length === 0 && paths.length === 0) return { ok: true, groups: [] };
  if (explicitWorkspace)
    return {
      ok: true,
      groups: [
        {
          workspace: explicitWorkspace,
          metadata: metadata.map(selectorText),
          sourceDirs: paths.map((selector) => selector.path),
        },
      ],
    };

  const groups = new Map<string, CmsGroup>();
  const groupOf = (workspace: string): CmsGroup => {
    const group = groups.get(workspace) ?? { workspace, metadata: [], sourceDirs: [] };
    groups.set(workspace, group);
    return group;
  };
  const required = (what: string, reason: string): Refusal => ({
    ok: false,
    code: 'WORKSPACE_REQUIRED',
    message: `The CMS workspace of ${what} is not clear: ${reason} Name it with --workspace.`,
    area: 'cms',
  });

  for (const selector of paths) {
    const [, workspace] = selector.path.split('/');
    if (workspace) groupOf(workspace).sourceDirs.push(selector.path);
    else {
      // eslint-disable-next-line no-await-in-loop -- sequential reads
      const folders = await subfolders(join(projectDir, 'cms'));
      if (folders.length === 0) return required(selector.raw, 'the cms/ folder has no workspace folder.');
      for (const folder of folders) groupOf(folder).sourceDirs.push(`cms/${folder}`);
    }
  }
  for (const selector of metadata) {
    // eslint-disable-next-line no-await-in-loop -- sequential reads
    const holding = await workspacesHolding(projectDir, selector);
    if (holding.length !== 1)
      return required(
        selectorText(selector),
        holding.length === 0
          ? 'no cms/<workspace>/ folder of the project holds it.'
          : `several workspace folders hold it (${holding.join(', ')}).`
      );
    groupOf(holding[0]).metadata.push(selectorText(selector));
  }
  return { ok: true, groups: [...groups.values()] };
}

type CmsRow = {
  type?: unknown;
  apiName?: unknown;
  outcome?: unknown;
  action?: unknown;
  reason?: unknown;
  path?: unknown;
  managedContentId?: unknown;
};

const CMS_OUTCOMES: Readonly<Record<string, Outcome>> = {
  create: 'would-create',
  update: 'would-update',
  delete: 'would-delete',
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  retrieved: 'retrieved',
  unchanged: 'unchanged',
  blocked: 'blocked',
  failed: 'failed',
  unknown: 'unknown',
  'not-attempted': 'not-attempted',
};

function cmsOutcome(row: CmsRow): Outcome {
  // A component whose references this run creates first: what the deploy does once they exist.
  if (row.outcome === 'planned-dependencies') return row.action === 'update' ? 'would-update' : 'would-create';
  return (typeof row.outcome === 'string' ? CMS_OUTCOMES[row.outcome] : undefined) ?? 'unknown';
}

function diagnosticText(diagnostic: CmsDiagnostic): string {
  return diagnostic.component ? `${diagnostic.component}: ${diagnostic.message}` : diagnostic.message;
}

/** The rows of a `sf-plugin-cms` envelope as items. */
export function cmsItems(result: CmsResult<unknown>): Item[] {
  const rows = (result.result as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(rows)) return [];
  return (rows as CmsRow[]).map((row) => {
    const type = String(row.type);
    const name = String(row.apiName);
    const outcome = cmsOutcome(row);
    const error = PROBLEM.has(outcome)
      ? result.diagnostics.errors.find((diagnostic) => diagnostic.component === `${type}:${name}`)
      : undefined;
    const code = typeof row.reason === 'string' ? row.reason : error?.code;
    return {
      area: 'cms',
      type,
      name,
      outcome,
      ...(typeof row.path === 'string' ? { path: row.path } : {}),
      ...(typeof row.managedContentId === 'string' ? { id: row.managedContentId } : {}),
      ...(code ? { code } : {}),
      ...(error ? { message: error.message } : {}),
    };
  });
}

/** API name of the workspace a `sf-plugin-cms` envelope worked on, when it got that far. */
export function cmsWorkspaceOf(result: CmsResult<unknown>): string | undefined {
  const workspace = (result.result as { workspace?: { apiName?: unknown } } | null | undefined)?.workspace;
  return typeof workspace?.apiName === 'string' ? workspace.apiName : undefined;
}

/** Adds one `sf-plugin-cms` envelope to a phase and returns its items. */
export function recordCms(phase: Phase, result: CmsResult<unknown>, code: Status): Item[] {
  const items = cmsItems(result);
  phase.cms.push(result);
  phase.codes.push(code);
  phase.items.push(...items);
  return items;
}

/**
 * The envelope of a run that ended with this phase: its items, the CMS envelopes unchanged (one
 * per workspace), their warnings and errors, and the status.
 */
export function withPhase(envelope: Envelope, phase: Phase): Envelope {
  const diagnostics = phase.cms.map((result) => result.diagnostics);
  return finish(
    {
      ...envelope,
      items: [...envelope.items, ...phase.items],
      areas: { ...envelope.areas, ...(phase.cms.length > 0 ? { cms: phase.cms } : {}) },
      warnings: [
        ...envelope.warnings,
        ...diagnostics.flatMap((entry) =>
          entry.warnings.map((warning) => `${warning.code}: ${diagnosticText(warning)}`)
        ),
      ],
      errors: [
        ...envelope.errors,
        ...diagnostics.flatMap((entry) =>
          entry.errors.map((error) => ({ code: error.code, message: diagnosticText(error), area: 'cms' as const }))
        ),
      ],
    },
    phase.codes
  );
}

export type WriteSelection = { own: McnextSelection; groups: CmsGroup[] };

const WRITE_WORDS = {
  deploy: { done: 'deployed', nothing: 'written' },
  delete: { done: 'deleted', nothing: 'deleted' },
} as const;

/**
 * What a deploy or delete names, from its flags and the files of the project folder. Every
 * refusal here comes before the org is read: an invalid selector, nothing selected, a Data 360
 * component (not available through this plugin yet), a path that is no campaign or flow file, a
 * CMS component whose workspace is not clear.
 */
export async function selectForWrite(
  envelope: Envelope,
  input: {
    verb: 'deploy' | 'delete';
    metadata?: string[];
    sourceDirs?: string[];
    projectDir: string;
    workspace?: string;
  }
): Promise<{ ok: true; selected: WriteSelection } | { ok: false; envelope: Envelope }> {
  const { verb, projectDir } = input;
  const no = (result: Envelope): { ok: false; envelope: Envelope } => ({ ok: false, envelope: result });
  const parsed = parseSelection(input.metadata, input.sourceDirs, projectDir);
  if (!parsed.ok) return no(refused(envelope, parsed.errors));
  const { selection } = parsed;
  if (selection.metadata.length === 0 && selection.paths.length === 0)
    return no(refuse(envelope, 'NOTHING_SELECTED', `Name what to ${verb} with --metadata or --source-dir.`));
  if (selectsArea(selection, 'data360'))
    return no(
      refuse(
        envelope,
        'DATA360_WRITE_NOT_AVAILABLE',
        `Data 360 components cannot be ${WRITE_WORDS[verb].done} through sf mcnext ${verb} yet. Use sf data360 ${verb} ` +
          `for them and run this command without the Data 360 selectors. Nothing was ${WRITE_WORDS[verb].nothing}.`,
        'data360'
      )
    );
  const own = await selectMcnext(selection, projectDir);
  if (!own.ok) return no(refuse(envelope, own.code, own.message, own.area));
  const grouped = await groupCms(selection, projectDir, input.workspace);
  if (!grouped.ok) return no(refuse(envelope, grouped.code, grouped.message, grouped.area));
  return { ok: true, selected: { own: own.selected, groups: grouped.groups } };
}
