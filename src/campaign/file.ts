import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type CampaignFile = {
  name: string;
  /** Writable Campaign fields as Salesforce returned them; the lookups below and `Name` are not in here. */
  fields: Record<string, unknown>;
  parent?: { sobject: 'Campaign'; name: string };
  businessUnit?: { developerName: string };
  brief?: { sobject: 'Brief'; name: string };
};

export const CAMPAIGN_FILE_SUFFIX = '.campaign.json';

// Not allowed in a Windows file name, plus "%" so the escaping stays reversible.
const UNSAFE = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*', '%']);
const FIRST_PRINTABLE = 32;
// Windows device names, reserved with any extension.
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/iu;

function escapeChar(char: string): string {
  return `%${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(2, '0')}`;
}

/** File name of a campaign name: characters a file system refuses become `%XX`. */
export function safeFileName(name: string): string {
  const escaped = [...name]
    .map((char) => (UNSAFE.has(char) || (char.codePointAt(0) ?? 0) < FIRST_PRINTABLE ? escapeChar(char) : char))
    .join('');
  return RESERVED.test(escaped) ? escapeChar(escaped[0]) + escaped.slice(1) : escaped;
}

/** `<projectDir>/mcnext/campaigns` */
export function campaignFolder(projectDir: string): string {
  return join(projectDir, 'mcnext', 'campaigns');
}

/**
 * `<projectDir>/mcnext/campaigns/<safe file name>.campaign.json` for a campaign without a business
 * unit, `<projectDir>/mcnext/campaigns/<business unit>/<safe file name>.campaign.json` for one with.
 */
export function campaignPath(projectDir: string, name: string, businessUnit?: string | null): string {
  return join(
    campaignFolder(projectDir),
    ...(businessUnit ? [safeFileName(businessUnit)] : []),
    `${safeFileName(name)}${CAMPAIGN_FILE_SUFFIX}`
  );
}

/**
 * The business unit a file's folder stands for: its developer name for
 * `mcnext/campaigns/<business unit>/<file>`, null for `mcnext/campaigns/<file>`, undefined for a
 * file anywhere else (its folder says nothing).
 */
export function businessUnitOfFolder(path: string): string | null | undefined {
  const folder = dirname(path);
  const isCampaigns = (candidate: string): boolean =>
    basename(candidate) === 'campaigns' && basename(dirname(candidate)) === 'mcnext';
  if (isCampaigns(folder)) return null;
  return isCampaigns(dirname(folder)) ? basename(folder) : undefined;
}

/** Why a file's folder and its `businessUnit` do not fit together; undefined when they do. */
export function folderMismatch(path: string, file: CampaignFile): string | undefined {
  const folder = businessUnitOfFolder(path);
  const named = file.businessUnit?.developerName ?? null;
  if (folder === undefined || (folder ?? '').toLowerCase() === safeFileName(named ?? '').toLowerCase())
    return undefined;
  const expected = named ? `mcnext/campaigns/${safeFileName(named)}/` : 'mcnext/campaigns/';
  return (
    `${path}: the file ${folder === null ? 'is not in a business unit folder' : `is in the folder of ${folder}`}, ` +
    `but its "businessUnit" ${named ? `is ${named}` : 'is missing'}. ` +
    `Move the file to ${expected} or correct "businessUnit".`
  );
}

/** Key of a campaign: its business unit (none: empty) and its name. */
export function campaignKey(businessUnit: string | null | undefined, name: string): string {
  return `${(businessUnit ?? '').toLowerCase()}/${name}`;
}

async function entriesOf(folder: string): Promise<Array<{ name: string; isFolder: boolean }>> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return entries
      .map((entry) => ({ name: entry.name, isFolder: entry.isDirectory() }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Every campaign file of the project: those directly in `mcnext/campaigns` first, then those of
 * each business unit folder below it.
 */
export async function campaignFilesOf(projectDir: string): Promise<string[]> {
  const root = campaignFolder(projectDir);
  const entries = await entriesOf(root);
  const isCampaignFile = (name: string): boolean => name.endsWith(CAMPAIGN_FILE_SUFFIX);
  const files = entries
    .filter((entry) => !entry.isFolder && isCampaignFile(entry.name))
    .map((entry) => join(root, entry.name));
  for (const entry of entries.filter((candidate) => candidate.isFolder)) {
    // eslint-disable-next-line no-await-in-loop -- one folder per business unit
    const inside = await entriesOf(join(root, entry.name));
    files.push(
      ...inside
        .filter((candidate) => !candidate.isFolder && isCampaignFile(candidate.name))
        .map((candidate) => join(root, entry.name, candidate.name))
    );
  }
  return files;
}

/** The files of the project named after this campaign: at most one per business unit folder and one without. */
export async function campaignFilesNamed(projectDir: string, name: string): Promise<string[]> {
  const wanted = `${safeFileName(name)}${CAMPAIGN_FILE_SUFFIX}`;
  return (await campaignFilesOf(projectDir)).filter((file) => basename(file) === wanted);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])])
  );
}

/** Fixed order of the top-level keys, fields sorted by name, LF and a trailing newline. */
export function serializeCampaignFile(file: CampaignFile): string {
  const ordered = {
    name: file.name,
    ...(file.businessUnit ? { businessUnit: { developerName: file.businessUnit.developerName } } : {}),
    ...(file.parent ? { parent: { sobject: 'Campaign', name: file.parent.name } } : {}),
    ...(file.brief ? { brief: { sobject: 'Brief', name: file.brief.name } } : {}),
    fields: sorted(file.fields),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function nameIn(value: unknown, key: string, path: string, property: string): string {
  const name = isRecord(value) ? value[key] : undefined;
  if (typeof name !== 'string' || name === '') throw new Error(`${path}: "${property}" needs a "${key}".`);
  return name;
}

/**
 * @throws when the file cannot be read, is not JSON or is not a campaign file.
 */
export async function readCampaignFile(path: string): Promise<CampaignFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${path}: a campaign file is a JSON object.`);
  if (typeof parsed.name !== 'string' || parsed.name === '') throw new Error(`${path}: "name" is missing.`);
  if (parsed.fields !== undefined && !isRecord(parsed.fields)) throw new Error(`${path}: "fields" is not an object.`);
  const file: CampaignFile = { name: parsed.name, fields: parsed.fields ?? {} };
  if (parsed.parent !== undefined)
    file.parent = { sobject: 'Campaign', name: nameIn(parsed.parent, 'name', path, 'parent') };
  if (parsed.businessUnit !== undefined)
    file.businessUnit = { developerName: nameIn(parsed.businessUnit, 'developerName', path, 'businessUnit') };
  if (parsed.brief !== undefined) file.brief = { sobject: 'Brief', name: nameIn(parsed.brief, 'name', path, 'brief') };
  return file;
}
