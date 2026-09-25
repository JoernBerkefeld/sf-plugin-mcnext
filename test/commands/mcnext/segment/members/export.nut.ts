import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCmd } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { SegmentMembersExportResult } from '../../../../../src/commands/mcnext/segment/members/export.js';
import { requirePrivateNutAlias, requirePrivateNutValue } from '../../../../support/privateNutValues.js';

const NUT_ENABLED = process.env.SF_PLUGIN_MCNEXT_NUTS === '1';
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

let testDirectory: string | undefined;
let authorizedOrgAlias: string;
let publishedSegmentApiName: string;

(NUT_ENABLED ? describe : describe.skip)('mcnext segment members export NUT', () => {
  before('prepare authorized session', async () => {
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
    testDirectory = await mkdtemp(join(tmpdir(), 'sf-plugin-mcnext-nut-'));
  });

  after(async () => {
    if (testDirectory) await rm(testDirectory, { force: true, recursive: true });
  });

  it('exports a bounded member sample without mutation', async () => {
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
        env: {
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
});
