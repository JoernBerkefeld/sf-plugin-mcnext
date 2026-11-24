import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Connection } from '@salesforce/core';
import type { Item } from '../envelope.js';
import { campaignPath, serializeCampaignFile, type CampaignFile } from './file.js';
import {
  campaignItem,
  describeCampaign,
  isRow,
  messageOf,
  queryRows,
  readFailure,
  soqlQuote,
  type CampaignDescribe,
  type Row,
} from './shared.js';

export type RetrieveCampaignsOptions = { names?: string[]; businessUnitId?: string; outputDir: string };

/** Name shown for a read of all campaigns that failed as a whole. */
const ALL = '*';

function related(row: Row, relationship: string | null, field: string): string | null {
  const record = relationship ? row[relationship] : null;
  const value = isRow(record) ? record[field] : null;
  return typeof value === 'string' && value !== '' ? value : null;
}

function toFile(row: Row, name: string, describe: CampaignDescribe): CampaignFile {
  const fields: Record<string, unknown> = {};
  for (const field of describe.fileFields) {
    const value = row[field];
    if (value !== null && value !== undefined) fields[field] = value;
  }
  const file: CampaignFile = { name, fields };
  const parent = related(row, describe.parent, 'Name');
  const businessUnit = related(row, describe.businessUnit, 'DeveloperName');
  const brief = related(row, describe.brief, 'Name');
  if (parent) file.parent = { sobject: 'Campaign', name: parent };
  if (businessUnit) file.businessUnit = { developerName: businessUnit };
  if (brief) file.brief = { sobject: 'Brief', name: brief };
  return file;
}

function soqlOf(describe: CampaignDescribe, opts: RetrieveCampaignsOptions): string {
  const select = [
    'Id',
    'Name',
    ...describe.fileFields,
    ...(describe.parent ? [`${describe.parent}.Name`] : []),
    ...(describe.businessUnit ? [`${describe.businessUnit}.DeveloperName`] : []),
    ...(describe.brief ? [`${describe.brief}.Name`] : []),
  ];
  const where = [
    ...(opts.names ? [`Name IN (${opts.names.map(soqlQuote).join(', ')})`] : []),
    ...(opts.businessUnitId && describe.businessUnit ? [`BusinessUnitId = ${soqlQuote(opts.businessUnitId)}`] : []),
  ];
  return `SELECT ${select.join(', ')} FROM Campaign${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}`;
}

/**
 * Write one file per campaign into `<outputDir>/mcnext/campaigns`: a campaign of a business unit
 * into the folder of that business unit below it, a campaign without one (and every campaign of an
 * org without business units) directly into it. Without `names` every campaign is read, of that
 * business unit when one is given. Existing files are replaced.
 *
 * Campaigns whose files fall together (same business unit and the same name, or names differing
 * only in case) are not written: one file cannot stand for two records.
 */
export async function retrieveCampaigns(connection: Connection, opts: RetrieveCampaignsOptions): Promise<Item[]> {
  const names = opts.names ? [...new Set(opts.names)] : undefined;
  if (names?.length === 0) return [];
  let describe: CampaignDescribe;
  let rows: Row[];
  try {
    describe = await describeCampaign(connection);
    rows = await queryRows(connection, soqlOf(describe, { ...opts, names }));
  } catch (error) {
    return (names ?? [ALL]).map((name) => campaignItem(name, 'failed', readFailure(error)));
  }
  const wanted = names ? new Set(names) : null;
  const found = rows.filter(
    (row): row is Row & { Id: string; Name: string } =>
      typeof row.Id === 'string' && typeof row.Name === 'string' && (!wanted || wanted.has(row.Name))
  );
  const scopeIgnored =
    opts.businessUnitId && !describe.businessUnit
      ? 'This org does not use business units: the business unit filter was ignored.'
      : undefined;

  const pathOf = (row: Row & { Name: string }): string =>
    campaignPath(opts.outputDir, row.Name, related(row, describe.businessUnit, 'DeveloperName'));
  const perPath = new Map<string, number>();
  for (const row of found) perPath.set(pathOf(row).toLowerCase(), (perPath.get(pathOf(row).toLowerCase()) ?? 0) + 1);

  const items: Item[] = [];
  for (const row of found) {
    const path = pathOf(row);
    if ((perPath.get(path.toLowerCase()) ?? 0) > 1) {
      items.push(
        campaignItem(row.Name, 'blocked', {
          id: row.Id,
          path,
          code: 'CAMPAIGN_NAME_AMBIGUOUS',
          message: `Several campaigns share the file of "${row.Name}"; none of them was written. Rename them in the org.`,
        })
      );
    } else {
      try {
        // One file after the other: a full disk stops at the first file.
        // eslint-disable-next-line no-await-in-loop -- sequential writes
        await mkdir(dirname(path), { recursive: true });
        // eslint-disable-next-line no-await-in-loop -- sequential writes
        await writeFile(path, serializeCampaignFile(toFile(row, row.Name, describe)), 'utf8');
        items.push(campaignItem(row.Name, 'retrieved', { id: row.Id, path, message: scopeIgnored }));
      } catch (error) {
        items.push(
          campaignItem(row.Name, 'failed', {
            id: row.Id,
            path,
            code: 'CAMPAIGN_FILE_WRITE_FAILED',
            message: messageOf(error),
          })
        );
      }
    }
  }
  const foundNames = new Set(found.map((row) => row.Name));
  for (const name of names ?? []) {
    if (!foundNames.has(name))
      items.push(
        campaignItem(name, 'failed', {
          code: 'CAMPAIGN_NOT_FOUND',
          message: `No campaign named "${name}"${
            opts.businessUnitId && describe.businessUnit ? ' in this business unit' : ''
          }.`,
        })
      );
  }
  return items;
}
