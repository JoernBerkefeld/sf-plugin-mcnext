import { unlink } from 'node:fs/promises';
import type { Connection } from '@salesforce/core';
import type { Item, Outcome } from '../envelope.js';
import { findCampaignsByName } from './deploy.js';
import { campaignFilesNamed, folderMismatch, readCampaignFile } from './file.js';
import {
  bucketText,
  campaignItem,
  describeCampaign,
  findBusinessUnitId,
  isRow,
  messageOf,
  readFailure,
  writeOnce,
  type Bucket,
  type Problem,
} from './shared.js';

/** A campaign to delete: its exact name and the file it was selected from (`-d`, a bare type). */
export type CampaignToRemove = { name: string; path?: string };

export type RemoveCampaignsOptions = {
  campaigns: CampaignToRemove[];
  preview: boolean;
  projectDir: string;
  keepLocalFiles: boolean;
};

/** One campaign to delete, with what its local file says about where it lives. */
type Target = {
  name: string;
  paths: string[];
  /** Developer name of the file's business unit; null: the file names none; undefined: there is no local file. */
  businessUnit?: string | null;
  problem?: Problem;
};

const STOPPED: ReadonlySet<Outcome> = new Set<Outcome>(['failed', 'blocked', 'unknown']);
const SELECT_FILE = 'Select the file of the one to delete with --source-dir (-d).';

/**
 * The file decides which campaign of that name is meant: the one given, else the one file of the
 * project named after the campaign. Several such files leave the choice open.
 */
async function targetOf({ name, path }: CampaignToRemove, projectDir: string): Promise<Target> {
  let file = path;
  try {
    if (!file) {
      const files = await campaignFilesNamed(projectDir, name);
      // No file was selected, so none is removed afterwards.
      if (files.length === 0) return { name, paths: [] };
      if (files.length > 1)
        return {
          name,
          paths: files,
          problem: {
            outcome: 'blocked',
            code: 'CAMPAIGN_NAME_AMBIGUOUS',
            message: `${files.length} local files are named after the campaign "${name}": ${files.join(
              ', '
            )}. ${SELECT_FILE}`,
          },
        };
      [file] = files;
    }
    const content = await readCampaignFile(file);
    const mismatch = folderMismatch(file, content);
    if (mismatch)
      return { name, paths: [file], problem: { outcome: 'blocked', code: 'CAMPAIGN_FILE_INVALID', message: mismatch } };
    if (content.name !== name)
      return {
        name,
        paths: [file],
        problem: {
          outcome: 'blocked',
          code: 'CAMPAIGN_FILE_INVALID',
          message: `${file}: the file is named after the campaign "${name}", but its "name" is "${content.name}". Correct "name" or rename the file.`,
        },
      };
    return { name, paths: [file], businessUnit: content.businessUnit?.developerName ?? null };
  } catch (error) {
    return {
      name,
      paths: file ? [file] : [],
      problem: { outcome: 'failed', code: 'CAMPAIGN_FILE_INVALID', message: messageOf(error) },
    };
  }
}

/** Removes the files; one that is not there is fine. Note for the Item when a file is still there. */
async function removeLocalFiles(paths: readonly string[]): Promise<string | undefined> {
  const problems: string[] = [];
  for (const path of paths) {
    try {
      // eslint-disable-next-line no-await-in-loop -- a handful of files
      await unlink(path);
    } catch (error) {
      if (!(isRow(error) && error.code === 'ENOENT')) problems.push(messageOf(error));
    }
  }
  return problems.length > 0
    ? `The campaign was deleted in the org, but its file could not be removed: ${problems.join(' ')}`
    : undefined;
}

/** Where the campaign is looked up; a Problem when the file's business unit is not in the org. */
async function bucketOf(
  connection: Connection,
  target: Target
): Promise<{ bucket: Bucket; businessUnits: boolean } | Problem> {
  const describe = await describeCampaign(connection);
  const businessUnits = describe.businessUnit !== null;
  // Without business units, and without a local file, the name is looked up in the whole org.
  if (!businessUnits || target.businessUnit === undefined) return { bucket: undefined, businessUnits };
  if (target.businessUnit === null) return { bucket: { businessUnitId: null }, businessUnits };
  const id = await findBusinessUnitId(connection, target.businessUnit);
  return id
    ? { bucket: { businessUnitId: id }, businessUnits }
    : {
        outcome: 'blocked',
        code: 'CAMPAIGN_BUSINESS_UNIT_NOT_FOUND',
        message: `There is no business unit ${target.businessUnit} in this org.`,
      };
}

async function removeOne(connection: Connection, target: Target, opts: RemoveCampaignsOptions): Promise<Item> {
  const { name, paths } = target;
  const path = paths[0];
  const stop = (problem: Problem, id?: string): Item =>
    campaignItem(name, problem.outcome, { id, path, code: problem.code, message: problem.message });
  if (target.problem) return stop(target.problem);
  let bucket: Bucket;
  let businessUnits: boolean;
  let matches: Array<{ Id: string }>;
  try {
    const found = await bucketOf(connection, target);
    if ('outcome' in found) return stop(found);
    ({ bucket, businessUnits } = found);
    matches = await findCampaignsByName(connection, name, bucket);
  } catch (error) {
    return stop(readFailure(error));
  }
  const where = bucket ? ` ${bucketText(target.businessUnit)}` : '';
  if (matches.length === 0)
    return campaignItem(name, 'unchanged', {
      path,
      message: `There is no campaign named "${name}"${where} in the org.`,
    });
  if (matches.length > 1)
    return stop({
      outcome: 'blocked',
      code: 'CAMPAIGN_NAME_AMBIGUOUS',
      message:
        `${matches.length} campaigns${where} are named "${name}"; a delete needs exactly one. ` +
        (businessUnits && !bucket
          ? `Retrieve them: campaigns of different business units get one file each. ${SELECT_FILE}`
          : 'Rename the others in the org.'),
    });
  const id = matches[0].Id;
  if (opts.preview) return campaignItem(name, 'would-delete', { id, path });
  const written = await writeOnce(() => connection.sobject('Campaign').destroy(id));
  if (!written.ok) return stop(written, id);
  // Only now, with the delete confirmed, are the local files removed.
  const message = opts.keepLocalFiles ? undefined : await removeLocalFiles(paths);
  return campaignItem(name, 'deleted', { id, path, message });
}

/**
 * Delete campaigns by exact name. A campaign selected by a file is the one in the business unit
 * that file names (none: the one without a business unit); a campaign given by name alone takes
 * that from the one project file named after it. Without such a file the name is looked up in the
 * whole org; several project files of that name, or several campaigns in the org, are blocked. In
 * an org without business units the name alone counts.
 *
 * One Item per campaign. After a confirmed delete (`deleted`) the files the campaign was selected
 * from are removed, unless `keepLocalFiles`. No other outcome touches a file. With `preview`
 * nothing is deleted and every campaign is checked. A real run stops at the first campaign that is
 * failed, blocked or unknown; the campaigns after it are `not-attempted`.
 */
export async function removeCampaigns(connection: Connection, opts: RemoveCampaignsOptions): Promise<Item[]> {
  const targets = new Map<string, Target>();
  for (const [index, campaign] of opts.campaigns.entries()) {
    // eslint-disable-next-line no-await-in-loop -- a handful of local files
    const target = await targetOf(campaign, opts.projectDir);
    const unit = target.businessUnit === undefined ? 'any' : `unit:${(target.businessUnit ?? '').toLowerCase()}`;
    const key = target.problem ? `problem:${index}` : `${unit}/${target.name}`;
    const known = targets.get(key);
    if (known) known.paths = [...new Set([...known.paths, ...target.paths])];
    else targets.set(key, target);
  }
  const items: Item[] = [];
  let stopped = false;
  for (const target of targets.values()) {
    if (stopped) items.push(campaignItem(target.name, 'not-attempted', { path: target.paths[0] }));
    else {
      // One delete after the other keeps the load on the org small.
      // eslint-disable-next-line no-await-in-loop -- sequential writes
      const item = await removeOne(connection, target, opts);
      items.push(item);
      stopped = !opts.preview && STOPPED.has(item.outcome);
    }
  }
  return items;
}
