import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { determineExecutable, execCmd } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
// eslint-disable-next-line import/no-extraneous-dependencies -- csv-parse is installed through the declared Salesforce dependencies
import { parse } from 'csv-parse/sync';
import { SegmentMembersExportResult } from '../../../../../src/commands/mcnext/segment/members/export.js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
  RunOwnedTemp,
} from '../../../../../src/filesystem/runOwnedTemp.js';
import { requirePrivateNutAlias, requirePrivateNutValue } from '../../../../support/privateNutValues.js';

const NUT_ENABLED = process.env.SF_PLUGIN_MCNEXT_NUTS === '1';
const ENRICHED_NUT_ENABLED = process.env.SF_PLUGIN_MCNEXT_ENRICHED_NUTS === '1';
const PACKAGE_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const LOCAL_ENTRYPOINT = join(PACKAGE_ROOT, 'bin', process.platform === 'win32' ? 'run.cmd' : 'run.js');
const GLOBAL_SF_ENTRYPOINT = join(
  process.env.APPDATA ?? '',
  'npm',
  'node_modules',
  '@salesforce',
  'cli',
  'bin',
  'run.js'
);
const AUTHORIZED_ORG_ALIAS = process.env.SF_PLUGIN_MCNEXT_NUT_ORG_ALIAS;
const AUTHORIZED_ORG_ID = process.env.SF_PLUGIN_MCNEXT_NUT_ORG_ID;
const PUBLISHED_SEGMENT_API_NAME = process.env.SF_PLUGIN_MCNEXT_NUT_SEGMENT_API_NAME;
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const MAX_ITEMS = 10_000;

let run: RunOwnedTemp | undefined;
let testDirectory: string | undefined;
let authorizedOrgAlias: string;
let publishedSegmentApiName: string;
let expectedMembershipCount: number;
let dataSpace: string;

/** Refuse relative, redirected, or drive-root temp paths before any live work. */
function verifyTempEnvironment(): void {
  for (const value of [process.env.TEMP, tmpdir(), ...[process.env.TMP, process.env.TMPDIR].filter(Boolean)]) {
    if (
      !value ||
      !isAbsolute(value) ||
      normalize(value)
        .replace(/[\\/]+$/u, '')
        .toLowerCase() !== normalize('F:/Temp').toLowerCase()
    ) {
      throw new Error('NUT requires TEMP, os.tmpdir(), and nonempty TMP/TMPDIR to resolve to F:/Temp');
    }
  }
}

(NUT_ENABLED || ENRICHED_NUT_ENABLED ? describe : describe.skip)('mcnext segment members export NUT', () => {
  before('prepare authorized session', async () => {
    verifyTempEnvironment();
    // Testkit resolves the executable before applying per-command env/cwd options.
    expect(resolve(determineExecutable())).to.equal(LOCAL_ENTRYPOINT);
    if (ENRICHED_NUT_ENABLED) {
      expectedMembershipCount = Number(
        requirePrivateNutValue(
          'SF_PLUGIN_MCNEXT_NUT_EXPECTED_MEMBERSHIP_COUNT',
          process.env.SF_PLUGIN_MCNEXT_NUT_EXPECTED_MEMBERSHIP_COUNT,
          /^[1-9][0-9]{3}$/u
        )
      );
      expect(expectedMembershipCount).to.be.greaterThan(1000).and.lessThan(MAX_ITEMS);
      dataSpace = requirePrivateNutValue(
        'SF_PLUGIN_MCNEXT_NUT_DATA_SPACE',
        process.env.SF_PLUGIN_MCNEXT_NUT_DATA_SPACE ?? 'default',
        /^[A-Za-z][A-Za-z0-9_]*$/u
      );
    }
    authorizedOrgAlias = requirePrivateNutAlias(AUTHORIZED_ORG_ALIAS);
    const expectedOrgId = requirePrivateNutValue(
      'SF_PLUGIN_MCNEXT_NUT_ORG_ID',
      AUTHORIZED_ORG_ID,
      /^00D[A-Za-z0-9]{15}$/
    );
    publishedSegmentApiName = requirePrivateNutValue(
      'SF_PLUGIN_MCNEXT_NUT_SEGMENT_API_NAME',
      PUBLISHED_SEGMENT_API_NAME,
      /^[A-Za-z][A-Za-z0-9_]*$/
    );
    const orgDisplay = execFileSync(
      process.execPath,
      [GLOBAL_SF_ENTRYPOINT, 'org', 'display', '--target-org', authorizedOrgAlias, '--json'],
      { encoding: 'utf8' }
    );
    const org = JSON.parse(orgDisplay) as { result?: { id?: string } };
    expect(org.result?.id).to.equal(expectedOrgId);
    run = await createRunOwnedTemp('sf-plugin-mcnext-nut');
    testDirectory = await createRunOwnedDirectory(run, 'fixture');
    expect(Object.isFrozen(run)).to.equal(true);
    expect(testDirectory).to.equal(join(run.root, 'fixture'));
  });

  after(async () => {
    if (!run) return;
    if (testDirectory) await removeRunOwnedPath(run, testDirectory);
    await removeRunOwnedRoot(run);
  });

  (NUT_ENABLED ? it : it.skip)('exports a bounded member sample without mutation', async () => {
    if (!testDirectory) throw new Error('NUT temporary directory was not initialized');
    const outputFile = join(testDirectory, 'segment-members.json');
    const result = execCmd<SegmentMembersExportResult>(
      [
        'mcnext segment members export',
        `--target-org ${authorizedOrgAlias}`,
        `--segment ${publishedSegmentApiName}`,
        `--output-file "${outputFile}"`,
        '--result-format json',
        `--limit ${PAGE_SIZE}`,
        `--max-pages ${MAX_PAGES}`,
        `--max-items ${MAX_ITEMS}`,
        '--max-duration-ms 60000',
        '--api-version 67.0',
        '--json',
      ].join(' '),
      {
        ensureExitCode: 0,
        cwd: testDirectory,
        env: {
          ...process.env,
          SF_CONFIG_DIR: join(process.env.USERPROFILE ?? '', '.sf'),
        },
      }
    ).jsonOutput?.result;

    expect(result).to.include({
      complete: true,
      resultFormat: 'json',
      segmentApiName: publishedSegmentApiName,
    });
    expect(result?.rowsWritten).to.be.at.least(0).and.at.most(MAX_ITEMS);

    const rows = JSON.parse(await readFile(outputFile, 'utf8')) as Array<Record<string, unknown>>;
    expect(rows).to.have.length(result?.rowsWritten ?? -1);
    expect(rows.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))).to.equal(true);
    expect(rows.every((row) => Object.keys(row).length > 0)).to.equal(true);
  });

  (ENRICHED_NUT_ENABLED ? it : it.skip)('exports all enriched members as 19-column CSV without mutation', async () => {
    if (!testDirectory) throw new Error('NUT temporary directory was not initialized');
    const outputFile = join(testDirectory, 'segment-members-enriched.csv');
    const result = execCmd<SegmentMembersExportResult>(
      [
        'mcnext segment members export',
        `--target-org ${authorizedOrgAlias}`,
        `--segment ${publishedSegmentApiName}`,
        `--output-file "${outputFile}"`,
        '--include-details',
        `--data-space ${dataSpace}`,
        '--result-format csv',
        '--column-headers api-name',
        `--limit ${PAGE_SIZE}`,
        `--max-pages ${MAX_PAGES + 1}`,
        `--max-items ${MAX_ITEMS}`,
        '--max-duration-ms 300000',
        '--api-version 67.0',
        '--json',
      ].join(' '),
      {
        ensureExitCode: 0,
        cwd: testDirectory,
        timeout: 360_000,
        env: {
          ...process.env,
          SF_CONFIG_DIR: join(process.env.USERPROFILE ?? '', '.sf'),
        },
      }
    ).jsonOutput?.result;

    expect(result).to.include({
      complete: true,
      includeDetails: true,
      resultFormat: 'csv',
      columnHeaders: 'api-name',
      segmentApiName: publishedSegmentApiName,
      dataSpace,
      rowsWritten: expectedMembershipCount,
    });
    expect(result?.rowsWritten).to.be.greaterThan(1000);
    expect(result?.enriched?.columns).to.have.length(19);
    // Parse CSV records, not physical lines: quoted fields may contain CRLF, commas, or escaped quotes.
    const [headers, ...records] = parse(await readFile(outputFile, 'utf8'));
    expect(headers).to.have.length(19);
    expect(headers).to.deep.equal(result?.enriched?.columns.map((column) => column.name));
    expect(records).to.have.length(result?.rowsWritten ?? -1);
    expect(records).to.have.length(expectedMembershipCount);
    expect(records.length).to.be.greaterThan(1000);
    expect(records.every((record) => record.length === 19)).to.equal(true);
  });
});
