import { basename } from 'node:path';
import type { Connection } from '@salesforce/core';
import type { Item, Outcome } from '../envelope.js';
import { CAMPAIGN_FILE_SUFFIX, campaignKey, folderMismatch, readCampaignFile, type CampaignFile } from './file.js';
import {
  bucketText,
  campaignItem,
  describeCampaign,
  findCampaignRows,
  messageOf,
  queryRows,
  readFailure,
  soqlQuote,
  writeOnce,
  type Bucket,
  type CampaignDescribe,
  type Problem,
  type Row,
} from './shared.js';

export type TargetBusinessUnit = { id: string; developerName: string };
export type DeployCampaignsOptions = { files: string[]; preview: boolean; targetBusinessUnit?: TargetBusinessUnit };

type Loaded = { path: string; file: CampaignFile } | { path: string; error: string };
type Resolved<T> = { ok: true; value: T } | { ok: false; problem: Problem };
type Lookups = { values: Row; parentComesInThisRun: boolean };
type State = { existing: Row | undefined; lookups: Lookups; businessUnitId: string | null };
type Context = {
  connection: Connection;
  describe: CampaignDescribe;
  preview: boolean;
  targetBusinessUnit?: TargetBusinessUnit;
};

const STOPPED: ReadonlySet<Outcome> = new Set<Outcome>(['failed', 'blocked', 'unknown']);

/** Fields a campaign file never holds under `fields`, by lower-case name, with what to write instead. */
const NOT_A_FILE_FIELD = new Map<string, string>([
  ['businessunitid', 'Name the business unit with "businessUnit": { "developerName": … } instead.'],
  ['parentid', 'Name the parent campaign with "parent": { "name": … } instead.'],
  ['briefid', 'Name the brief with "brief": { "name": … } instead.'],
  ['ownerid', 'A campaign file does not set the owner: remove it.'],
  ['recordtypeid', 'A campaign file does not set the record type: remove it.'],
]);

/** Why the file's `fields` cannot be sent; undefined when they can. */
function refusedFields(path: string, file: CampaignFile): string | undefined {
  const refused = Object.keys(file.fields).filter((field) => NOT_A_FILE_FIELD.has(field.toLowerCase()));
  if (refused.length === 0) return undefined;
  return `${path}: ${refused
    .map(
      (field) =>
        `"fields.${field}" is not written from a campaign file. ${NOT_A_FILE_FIELD.get(field.toLowerCase()) ?? ''}`
    )
    .join(' ')}`;
}

const blocked = (code: string, message: string): { ok: false; problem: Problem } => ({
  ok: false,
  problem: { outcome: 'blocked', code, message },
});

/**
 * Campaigns of exactly this name: of one business unit, of none, or (without `bucket`) of the whole org.
 *
 * @throws when Salesforce does not answer the read.
 */
export async function findCampaignsByName(
  connection: Connection,
  name: string,
  bucket?: Bucket
): Promise<Array<{ Id: string }>> {
  const rows = await findCampaignRows(connection, name, [], bucket);
  return rows.map((row) => ({ Id: String(row.Id) }));
}

function equal(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** ID of the one record a lookup names; blocked when there is none or more than one. */
async function idByName(
  connection: Connection,
  soql: string,
  codePrefix: string,
  what: string
): Promise<Resolved<string | null>> {
  const ids = (await queryRows(connection, soql))
    .map((row) => row.Id)
    .filter((id): id is string => typeof id === 'string');
  if (ids.length > 1)
    return blocked(`${codePrefix}_AMBIGUOUS`, `Several records match ${what}; the lookup needs exactly one.`);
  return { ok: true, value: ids[0] ?? null };
}

/**
 * The parent is the campaign of that name in the campaign's own business unit: in the org, else
 * one this run writes there. Only when neither exists is it the one campaign of that name anywhere
 * in the org.
 */
async function resolveLookups(
  context: Context,
  file: CampaignFile,
  parentInRun: boolean,
  bucket: Bucket
): Promise<Resolved<Lookups>> {
  const { connection, describe } = context;
  const lookups: Lookups = { values: {}, parentComesInThisRun: false };
  if (file.parent) {
    const what = `the parent campaign "${file.parent.name}"`;
    let rows = describe.parent ? await findCampaignRows(connection, file.parent.name, [], bucket) : [];
    if (rows.length === 0 && bucket && !parentInRun && describe.parent)
      rows = await findCampaignRows(connection, file.parent.name, []);
    if (rows.length > 1)
      return blocked('CAMPAIGN_PARENT_AMBIGUOUS', `Several records match ${what}; the lookup needs exactly one.`);
    if (rows.length === 1) lookups.values.ParentId = rows[0].Id;
    else if (parentInRun) lookups.parentComesInThisRun = true;
    else return blocked('CAMPAIGN_PARENT_NOT_FOUND', `There is no campaign named "${file.parent.name}" for ${what}.`);
  }
  if (file.brief) {
    const what = `the brief "${file.brief.name}"`;
    if (!describe.brief)
      return blocked('CAMPAIGN_BRIEF_NOT_FOUND', `Campaigns of this org have no brief, so ${what} cannot be set.`);
    const brief = await idByName(
      connection,
      `SELECT Id FROM Brief WHERE Name = ${soqlQuote(file.brief.name)}`,
      'CAMPAIGN_BRIEF',
      what
    );
    if (!brief.ok) return brief;
    if (!brief.value) return blocked('CAMPAIGN_BRIEF_NOT_FOUND', `There is no brief named "${file.brief.name}".`);
    lookups.values.BriefId = brief.value;
  }
  return { ok: true, value: lookups };
}

/** ID of the business unit the campaign belongs in; null when the file and the run name none. */
async function resolveBusinessUnit(
  context: Context,
  file: CampaignFile,
  notes: string[]
): Promise<Resolved<string | null>> {
  const named = context.targetBusinessUnit?.developerName ?? file.businessUnit?.developerName;
  if (!named) return { ok: true, value: null };
  if (!context.describe.businessUnit) {
    notes.push(`This org does not use business units: the business unit ${named} was ignored.`);
    return { ok: true, value: null };
  }
  if (context.targetBusinessUnit) return { ok: true, value: context.targetBusinessUnit.id };
  const unit = await idByName(
    context.connection,
    `SELECT Id FROM BusinessUnit WHERE DeveloperName = ${soqlQuote(named)}`,
    'CAMPAIGN_BUSINESS_UNIT',
    `the business unit ${named}`
  );
  if (!unit.ok) return unit;
  if (!unit.value)
    return blocked('CAMPAIGN_BUSINESS_UNIT_NOT_FOUND', `There is no business unit ${named} in this org.`);
  return { ok: true, value: unit.value };
}

/** The file's fields and lookups that differ from the record. Fields the org does not know always count. */
function changesOf(describe: CampaignDescribe, file: CampaignFile, lookups: Lookups, existing: Row): Row {
  const changes: Row = {};
  for (const [field, value] of Object.entries({ ...file.fields, ...lookups.values })) {
    if (!describe.all.has(field) || !equal(existing[field], value)) changes[field] = value;
  }
  return changes;
}

/** Everything read before a write: the business unit, the campaign of that name in it, and the lookups. */
async function readState(
  context: Context,
  file: CampaignFile,
  parentInRun: boolean,
  notes: string[]
): Promise<Resolved<State>> {
  const { connection, describe } = context;
  const select = [
    ...Object.keys(file.fields).filter((field) => describe.all.has(field)),
    ...(file.parent && describe.parent ? ['ParentId'] : []),
    ...(file.brief && describe.brief ? ['BriefId'] : []),
  ];
  const unit = await resolveBusinessUnit(context, file, notes);
  if (!unit.ok) return unit;
  // With business units a name stands for one campaign per business unit, and one without any.
  const bucket: Bucket = describe.businessUnit ? { businessUnitId: unit.value } : undefined;
  const matches = await findCampaignRows(connection, file.name, select, bucket);
  if (matches.length > 1) {
    const where = bucket
      ? ` ${bucketText(context.targetBusinessUnit?.developerName ?? file.businessUnit?.developerName)}`
      : '';
    return blocked(
      'CAMPAIGN_NAME_AMBIGUOUS',
      `${matches.length} campaigns${where} are named "${file.name}"; a deploy needs exactly one. Rename the others in the org.`
    );
  }
  const lookups = await resolveLookups(context, file, parentInRun, bucket);
  if (!lookups.ok) return lookups;
  return { ok: true, value: { existing: matches[0], lookups: lookups.value, businessUnitId: unit.value } };
}

async function deployOne(context: Context, file: CampaignFile, path: string, parentInRun: boolean): Promise<Item> {
  const { connection, describe, preview } = context;
  const notes: string[] = [];
  const stop = (problem: Problem, id?: string): Item =>
    campaignItem(file.name, problem.outcome, { id, path, code: problem.code, message: problem.message });
  const done = (outcome: Outcome, id?: string): Item =>
    campaignItem(file.name, outcome, { id, path, message: notes.join(' ') });

  const mismatch = folderMismatch(path, file);
  if (mismatch) return stop({ outcome: 'blocked', code: 'CAMPAIGN_FILE_INVALID', message: mismatch });
  const refused = refusedFields(path, file);
  if (refused) return stop({ outcome: 'blocked', code: 'CAMPAIGN_FILE_INVALID', message: refused });
  let state: Resolved<State>;
  try {
    state = await readState(context, file, parentInRun, notes);
  } catch (error) {
    return stop(readFailure(error));
  }
  if (!state.ok) return stop(state.problem);
  const { existing, lookups, businessUnitId } = state.value;
  if (lookups.parentComesInThisRun)
    notes.push(`The parent campaign "${file.parent?.name ?? ''}" is created in this run.`);

  if (!existing) {
    if (preview) return done('would-create');
    const record = {
      ...file.fields,
      Name: file.name,
      ...lookups.values,
      ...(businessUnitId ? { BusinessUnitId: businessUnitId } : {}),
    };
    const written = await writeOnce(() => connection.sobject('Campaign').create(record));
    return written.ok ? done('created', written.id) : stop(written);
  }

  const id = String(existing.Id);
  // Salesforce does not let a campaign change its business unit, so it is never part of an update.
  const changes = changesOf(describe, file, lookups, existing);
  if (Object.keys(changes).length === 0 && !lookups.parentComesInThisRun) return done('unchanged', id);
  if (preview) return done('would-update', id);
  const written = await writeOnce(() => connection.sobject('Campaign').update({ Id: id, ...changes }));
  return written.ok ? done('updated', id) : stop(written, id);
}

async function load(path: string): Promise<Loaded> {
  try {
    return { path, file: await readCampaignFile(path) };
  } catch (error) {
    return { path, error: messageOf(error) };
  }
}

function nameOfPath(path: string): string {
  const name = basename(path);
  return name.endsWith(CAMPAIGN_FILE_SUFFIX) ? name.slice(0, -CAMPAIGN_FILE_SUFFIX.length) : name;
}

/**
 * Create or update one campaign per file, found by its exact name within its business unit: the
 * target business unit when given, else the file's, else among the campaigns without one. In an
 * org without business units the name alone counts. One Item per file, in the order of `files`; a
 * parent campaign of the same run and the same business unit is written before its children. With
 * `preview` nothing is written and every file is checked. A real run stops at the first campaign
 * that is failed, blocked or unknown; the campaigns not written by then are `not-attempted`.
 * Several files that stand for the same campaign are all blocked, and a real run then writes nothing.
 */
export async function deployCampaigns(connection: Connection, opts: DeployCampaignsOptions): Promise<Item[]> {
  const loaded = await Promise.all(opts.files.map(load));
  const unreadable = (entry: { path: string; error: string }): Item =>
    campaignItem(nameOfPath(entry.path), 'failed', {
      path: entry.path,
      code: 'CAMPAIGN_FILE_INVALID',
      message: entry.error,
    });
  let describe: CampaignDescribe;
  try {
    describe = await describeCampaign(connection);
  } catch (error) {
    return loaded.map((entry) =>
      'error' in entry
        ? unreadable(entry)
        : campaignItem(entry.file.name, 'failed', { path: entry.path, ...readFailure(error) })
    );
  }
  const context: Context = { connection, describe, preview: opts.preview, targetBusinessUnit: opts.targetBusinessUnit };

  const keyOf = (file: CampaignFile, name: string): string =>
    campaignKey(
      describe.businessUnit ? opts.targetBusinessUnit?.developerName ?? file.businessUnit?.developerName : null,
      name
    );
  const indexOfKey = new Map<string, number>();
  const indexesOfKey = new Map<string, number[]>();
  for (const [index, entry] of loaded.entries()) {
    if (!('file' in entry)) continue;
    const key = keyOf(entry.file, entry.file.name);
    if (!indexOfKey.has(key)) indexOfKey.set(key, index);
    indexesOfKey.set(key, [...(indexesOfKey.get(key) ?? []), index]);
  }
  const items = new Map<number, Item>();
  const started = new Set<number>();
  let stopped = false;
  // Several files for one campaign: none of them is written, and a real run writes nothing at all.
  for (const indexes of indexesOfKey.values()) {
    if (indexes.length === 1) continue;
    const paths = indexes.map((index) => loaded[index].path);
    for (const index of indexes) {
      const entry = loaded[index];
      if (!('file' in entry)) continue;
      const unit = opts.targetBusinessUnit?.developerName ?? entry.file.businessUnit?.developerName;
      const where = describe.businessUnit ? ` ${bucketText(unit)}` : '';
      started.add(index);
      items.set(
        index,
        campaignItem(entry.file.name, 'blocked', {
          path: entry.path,
          code: 'CAMPAIGN_NAME_AMBIGUOUS',
          message:
            `${paths.length} files of this run are the campaign "${entry.file.name}"${where}: ${paths.join(', ')}. ` +
            'Select one of them with --source-dir (-d).',
        })
      );
    }
    if (!opts.preview) stopped = true;
  }
  const record = (index: number, item: Item): void => {
    items.set(index, item);
    if (!opts.preview && STOPPED.has(item.outcome)) stopped = true;
  };
  const skipped = (entry: Loaded): Item =>
    campaignItem('file' in entry ? entry.file.name : nameOfPath(entry.path), 'not-attempted', { path: entry.path });
  const run = async (index: number): Promise<void> => {
    if (started.has(index)) return;
    started.add(index);
    const entry = loaded[index];
    if (stopped) {
      items.set(index, skipped(entry));
      return;
    }
    if ('error' in entry) {
      record(index, unreadable(entry));
      return;
    }
    const parentIndex = entry.file.parent ? indexOfKey.get(keyOf(entry.file, entry.file.parent.name)) : undefined;
    if (parentIndex !== undefined) await run(parentIndex);
    // The parent, or a campaign written before it, stopped the run: the child is not written.
    if (stopped) {
      items.set(index, skipped(entry));
      return;
    }
    // In a preview the parent does not exist yet; it counts when this run would write it.
    const parentItem = parentIndex === undefined ? undefined : items.get(parentIndex);
    const parentInRun = opts.preview && parentItem !== undefined && !STOPPED.has(parentItem.outcome);
    record(index, await deployOne(context, entry.file, entry.path, parentInRun));
  };
  for (const index of loaded.keys()) {
    // One campaign after the other: a child needs its parent's record.
    // eslint-disable-next-line no-await-in-loop -- sequential writes
    await run(index);
  }
  return loaded.map((_, index) => items.get(index)).filter((item): item is Item => item !== undefined);
}
