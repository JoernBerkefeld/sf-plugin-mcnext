import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { expect } from 'chai';
import { deployCampaigns, findCampaignsByName } from '../../src/campaign/deploy.js';
import {
  businessUnitOfFolder,
  campaignFilesNamed,
  campaignFilesOf,
  campaignKey,
  campaignPath,
  folderMismatch,
  readCampaignFile,
  safeFileName,
  serializeCampaignFile,
  type CampaignFile,
} from '../../src/campaign/file.js';
import { removeCampaigns } from '../../src/campaign/remove.js';
import { retrieveCampaigns } from '../../src/campaign/retrieve.js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
  type RunOwnedTemp,
} from '../../scripts/run-owned-temp.mjs';
import { BUSINESS_UNITS, DISABLED_FIELDS, fakeOrg, type Row } from './fakeOrg.js';

const DEFAULT_UNIT = BUSINESS_UNITS[0].Id as string;
const OTHER_UNIT = BUSINESS_UNITS[1].Id as string;
const BRIEFS: Row[] = [{ Id: '0Xx000000000001AAA', Name: 'Spring brief' }];
const IN_DEFAULT = { businessUnit: { developerName: 'defaultBusinessUnit' } };
const IN_OTHER = { businessUnit: { developerName: 'otherBusinessUnit' } };

const PLAN: Row = { Id: '701000000000901AAA', Name: 'Annual Plan', Status: 'Planned', BusinessUnitId: DEFAULT_UNIT };
const SPRING: Row = {
  Id: '701000000000902AAA',
  Name: 'Spring Sale',
  Description: 'Line one\nLine two',
  Status: 'Planned',
  Stage: 'In Planning',
  StartDate: '2026-03-01',
  IsActive: false,
  BudgetedCost: 1200.5,
  OwnerId: '005000000000001AAA',
  RecordTypeId: '012000000000001AAA',
  ParentId: PLAN.Id,
  BusinessUnitId: OTHER_UNIT,
  BriefId: BRIEFS[0].Id,
  NumberOfLeads: 7,
  CreatedDate: '2026-01-01T00:00:00.000+0000',
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('campaign', () => {
  let run: RunOwnedTemp;
  let root: string;
  let cases = 0;

  // One registered OS-temp folder for the whole suite; each test gets its own project folder in it.
  before(async () => {
    run = await createRunOwnedTemp('sf-mcnext-campaign-test');
    root = await createRunOwnedDirectory(run, 'projects');
  });

  after(async () => {
    await removeRunOwnedPath(run, root);
    await removeRunOwnedRoot(run);
  });

  async function project(): Promise<string> {
    cases += 1;
    const dir = join(root, `case-${cases}`);
    await mkdir(dir);
    return dir;
  }

  async function write(dir: string, file: CampaignFile): Promise<string> {
    const path = campaignPath(dir, file.name, file.businessUnit?.developerName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeCampaignFile(file), 'utf8');
    return path;
  }

  describe('file', () => {
    it('puts a campaign into mcnext/campaigns, and one of a business unit into the folder of that business unit', () => {
      expect(campaignPath('proj', 'Spring Sale')).to.equal(
        join('proj', 'mcnext', 'campaigns', 'Spring Sale.campaign.json')
      );
      expect(campaignPath('proj', 'Spring Sale', null)).to.equal(campaignPath('proj', 'Spring Sale'));
      expect(campaignPath('proj', 'Spring Sale', 'otherBusinessUnit')).to.equal(
        join('proj', 'mcnext', 'campaigns', 'otherBusinessUnit', 'Spring Sale.campaign.json')
      );
    });

    it('tells the business unit of a file from its folder, and when the file says otherwise', () => {
      const flat = campaignPath('proj', 'A');
      const inUnit = campaignPath('proj', 'A', 'otherBusinessUnit');
      expect(businessUnitOfFolder(flat)).to.equal(null);
      expect(businessUnitOfFolder(inUnit)).to.equal('otherBusinessUnit');
      expect(businessUnitOfFolder(join('proj', 'elsewhere', 'A.campaign.json'))).to.equal(undefined);
      expect(folderMismatch(flat, { name: 'A', fields: {} })).to.equal(undefined);
      expect(
        folderMismatch(inUnit, { name: 'A', fields: {}, businessUnit: { developerName: 'OtherBusinessUnit' } })
      ).to.equal(undefined);
      expect(
        folderMismatch(join('proj', 'elsewhere', 'A.campaign.json'), { name: 'A', fields: {}, ...IN_OTHER })
      ).to.equal(undefined);
      expect(folderMismatch(flat, { name: 'A', fields: {}, ...IN_OTHER })).to.include(
        'mcnext/campaigns/otherBusinessUnit/'
      );
      expect(folderMismatch(inUnit, { name: 'A', fields: {} })).to.include('"businessUnit" is missing');
      expect(folderMismatch(inUnit, { name: 'A', fields: {}, ...IN_DEFAULT })).to.include('defaultBusinessUnit');
      expect(campaignKey('OtherBusinessUnit', 'A')).to.equal('otherbusinessunit/A');
      expect(campaignKey(null, 'A')).to.equal('/A');
    });

    it('finds the campaign files of a project in the flat folder and one level of business unit folders', async () => {
      const dir = await project();
      const flat = await write(dir, { name: 'Spring', fields: {} });
      const inUnit = await write(dir, { name: 'Spring', fields: {}, ...IN_OTHER });
      const second = await write(dir, { name: 'Autumn', fields: {}, ...IN_DEFAULT });
      await mkdir(join(dirname(inUnit), 'deeper'));
      await writeFile(join(dirname(inUnit), 'deeper', 'Spring.campaign.json'), '{}', 'utf8');
      await writeFile(join(dirname(flat), 'notes.txt'), '', 'utf8');
      expect(await campaignFilesOf(dir)).to.deep.equal([flat, second, inUnit]);
      expect(await campaignFilesNamed(dir, 'Spring')).to.deep.equal([flat, inUnit]);
      expect(await campaignFilesNamed(dir, 'Winter')).to.deep.equal([]);
      expect(await campaignFilesOf(join(dir, 'no-project'))).to.deep.equal([]);
    });

    it('keeps names with slashes and other refused characters inside the campaigns folder', () => {
      const name = '../Q1/Q2\\Sale: 50%? <now> "x"|*';
      const safe = safeFileName(name);
      expect(safe).to.equal('..%2FQ1%2FQ2%5CSale%3A 50%25%3F %3Cnow%3E %22x%22%7C%2A');
      expect(dirname(campaignPath('proj', name))).to.equal(join('proj', 'mcnext', 'campaigns'));
      expect(basename(campaignPath('proj', name))).to.equal(`${safe}.campaign.json`);
      expect(decodeURIComponent(safe)).to.equal(name);
    });

    it('gives different names different files and escapes Windows device names', () => {
      expect(safeFileName('a/b')).to.not.equal(safeFileName('a%2Fb'));
      expect(safeFileName('CON')).to.equal('%43ON');
      expect(safeFileName('nul.old')).to.equal('%6Eul.old');
      expect(safeFileName('Console')).to.equal('Console');
      expect(safeFileName('tab\there')).to.equal('tab%09here');
    });

    it('serializes with a fixed key order, LF and a trailing newline', () => {
      const text = serializeCampaignFile({
        fields: { Status: 'Planned', Description: 'x', BudgetedCost: 1 },
        brief: { sobject: 'Brief', name: 'B' },
        parent: { sobject: 'Campaign', name: 'P' },
        businessUnit: { developerName: 'bu' },
        name: 'N',
      });
      expect(text).to.equal(
        [
          '{',
          '  "name": "N",',
          '  "businessUnit": {',
          '    "developerName": "bu"',
          '  },',
          '  "parent": {',
          '    "sobject": "Campaign",',
          '    "name": "P"',
          '  },',
          '  "brief": {',
          '    "sobject": "Brief",',
          '    "name": "B"',
          '  },',
          '  "fields": {',
          '    "BudgetedCost": 1,',
          '    "Description": "x",',
          '    "Status": "Planned"',
          '  }',
          '}',
          '',
        ].join('\n')
      );
    });

    it('reads back what it wrote', async () => {
      const dir = await project();
      const file: CampaignFile = {
        name: 'A/B',
        fields: { Status: 'Planned' },
        parent: { sobject: 'Campaign', name: 'P' },
        businessUnit: { developerName: 'bu' },
        brief: { sobject: 'Brief', name: 'B' },
      };
      expect(await readCampaignFile(await write(dir, file))).to.deep.equal(file);
    });

    it('refuses a file that is not a campaign file', async () => {
      const dir = await project();
      const invalid: Array<[string, string]> = [
        ['{', 'JSON'],
        ['[]', 'JSON object'],
        ['{"fields":{}}', '"name" is missing'],
        ['{"name":"x","fields":[]}', '"fields" is not an object'],
        ['{"name":"x","parent":{}}', '"parent" needs a "name"'],
        ['{"name":"x","businessUnit":{"name":"y"}}', '"businessUnit" needs a "developerName"'],
      ];
      for (const [index, [text, message]] of invalid.entries()) {
        const path = join(dir, `${index}.campaign.json`);
        // eslint-disable-next-line no-await-in-loop -- small fixture loop
        await writeFile(path, text, 'utf8');
        let caught = '';
        try {
          // eslint-disable-next-line no-await-in-loop -- small fixture loop
          await readCampaignFile(path);
        } catch (error) {
          caught = (error as Error).message;
        }
        expect(caught).to.include(message);
        expect(caught).to.include(path);
      }
    });
  });

  describe('retrieve', () => {
    it('writes the writable fields, names the lookups and leaves out nulls, owner, record type and roll-ups', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN, SPRING], briefs: BRIEFS });
      const items = await retrieveCampaigns(org.connection, { names: ['Spring Sale'], outputDir: dir });
      const path = campaignPath(dir, 'Spring Sale', 'otherBusinessUnit');
      expect(items).to.deep.equal([
        { area: 'mcnext', type: 'campaign', name: 'Spring Sale', outcome: 'retrieved', id: SPRING.Id, path },
      ]);
      expect(await readCampaignFile(path)).to.deep.equal({
        name: 'Spring Sale',
        fields: {
          BudgetedCost: 1200.5,
          Description: 'Line one\nLine two',
          IsActive: false,
          Stage: 'In Planning',
          StartDate: '2026-03-01',
          Status: 'Planned',
        },
        parent: { sobject: 'Campaign', name: 'Annual Plan' },
        businessUnit: { developerName: 'otherBusinessUnit' },
        brief: { sobject: 'Brief', name: 'Spring brief' },
      });
      const text = await readFile(path, 'utf8');
      expect(text).to.not.include('\r');
      expect(text.endsWith('}\n')).to.equal(true);
    });

    it('reads all campaigns without names, and those of one business unit when given', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN, SPRING], briefs: BRIEFS });
      const all = await retrieveCampaigns(org.connection, { outputDir: dir });
      expect(all.map((item) => [item.name, item.outcome])).to.deep.equal([
        ['Annual Plan', 'retrieved'],
        ['Spring Sale', 'retrieved'],
      ]);
      const scoped = await retrieveCampaigns(org.connection, { businessUnitId: OTHER_UNIT, outputDir: dir });
      expect(scoped.map((item) => item.name)).to.deep.equal(['Spring Sale']);
      expect(org.queries.at(-1)).to.include(`WHERE BusinessUnitId = '${OTHER_UNIT}'`);
    });

    it('replaces an existing file', async () => {
      const dir = await project();
      const path = await write(dir, {
        name: 'Annual Plan',
        fields: { Status: 'Old', Description: 'gone' },
        ...IN_DEFAULT,
      });
      await retrieveCampaigns(fakeOrg({ campaigns: [PLAN] }).connection, { outputDir: dir });
      expect((await readCampaignFile(path)).fields).to.deep.equal({ Status: 'Planned' });
    });

    it('reports a named campaign that does not exist, also when only the case differs', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN] });
      const items = await retrieveCampaigns(org.connection, { names: ['annual plan', "It's new"], outputDir: dir });
      expect(items.map((item) => [item.name, item.outcome, item.code])).to.deep.equal([
        ['annual plan', 'failed', 'CAMPAIGN_NOT_FOUND'],
        ["It's new", 'failed', 'CAMPAIGN_NOT_FOUND'],
      ]);
      expect(org.queries[0]).to.include("Name IN ('annual plan', 'It\\'s new')");
    });

    it('does not write campaigns that would share one file', async () => {
      const dir = await project();
      const twin = { ...PLAN, Id: '701000000000903AAA' };
      const org = fakeOrg({ campaigns: [PLAN, twin, { Id: '701000000000904AAA', Name: 'Solo' }] });
      const items = await retrieveCampaigns(org.connection, { outputDir: dir });
      expect(items.map((item) => [item.id, item.outcome, item.code])).to.deep.equal([
        [PLAN.Id, 'blocked', 'CAMPAIGN_NAME_AMBIGUOUS'],
        [twin.Id, 'blocked', 'CAMPAIGN_NAME_AMBIGUOUS'],
        ['701000000000904AAA', 'retrieved', undefined],
      ]);
      expect(await exists(campaignPath(dir, 'Annual Plan', 'defaultBusinessUnit'))).to.equal(false);
    });

    it('writes campaigns of one name into one file per business unit, and one without a business unit', async () => {
      const dir = await project();
      const other = { ...PLAN, Id: '701000000000908AAA', BusinessUnitId: OTHER_UNIT, Status: 'Other' };
      const none = { Id: '701000000000909AAA', Name: 'Annual Plan', Status: 'None' };
      const org = fakeOrg({ campaigns: [PLAN, other, none] });
      const items = await retrieveCampaigns(org.connection, { names: ['Annual Plan'], outputDir: dir });
      expect(items.map((item) => [item.id, item.outcome, item.path])).to.deep.equal([
        [PLAN.Id, 'retrieved', campaignPath(dir, 'Annual Plan', 'defaultBusinessUnit')],
        [other.Id, 'retrieved', campaignPath(dir, 'Annual Plan', 'otherBusinessUnit')],
        [none.Id, 'retrieved', campaignPath(dir, 'Annual Plan')],
      ]);
      expect(await readCampaignFile(campaignPath(dir, 'Annual Plan', 'otherBusinessUnit'))).to.deep.equal({
        name: 'Annual Plan',
        fields: { Status: 'Other' },
        ...IN_OTHER,
      });
      expect(await readCampaignFile(campaignPath(dir, 'Annual Plan'))).to.deep.equal({
        name: 'Annual Plan',
        fields: { Status: 'None' },
      });
      // The collision check is per business unit: a twin in one of them blocks only that file.
      org.campaigns.push({ ...other, Id: '701000000000910AAA' });
      const again = await retrieveCampaigns(org.connection, { names: ['Annual Plan'], outputDir: dir });
      expect(again.map((item) => item.outcome)).to.deep.equal(['retrieved', 'blocked', 'retrieved', 'blocked']);
    });

    it('never reads the business unit in an org without the feature', async () => {
      const dir = await project();
      const org = fakeOrg({ fields: DISABLED_FIELDS, campaigns: [{ Id: '701000000000905AAA', Name: 'Plain' }] });
      const items = await retrieveCampaigns(org.connection, { businessUnitId: OTHER_UNIT, outputDir: dir });
      expect(items).to.have.length(1);
      expect(items[0].outcome).to.equal('retrieved');
      expect(items[0].message).to.include('does not use business units');
      expect(org.queries.join(' ')).to.not.include('BusinessUnit');
      expect(await readCampaignFile(campaignPath(dir, 'Plain'))).to.deep.equal({ name: 'Plain', fields: {} });
    });

    it('returns failed items when the org cannot be read', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN] });
      org.failQuery = 'FROM Campaign';
      const named = await retrieveCampaigns(org.connection, { names: ['Annual Plan'], outputDir: dir });
      expect(named.map((item) => [item.name, item.outcome, item.code])).to.deep.equal([
        ['Annual Plan', 'failed', 'CAMPAIGN_READ_FAILED'],
      ]);
      org.failDescribe = true;
      const all = await retrieveCampaigns(org.connection, { outputDir: dir });
      expect(all.map((item) => [item.name, item.outcome, item.message])).to.deep.equal([
        ['*', 'failed', 'getaddrinfo ENOTFOUND org.example'],
      ]);
    });
  });

  describe('deploy', () => {
    it('creates a campaign that does not exist, with its lookups resolved', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN], briefs: BRIEFS });
      const path = await write(dir, {
        name: 'Spring Sale',
        fields: { Status: 'Planned', Stage: 'Not a stage Salesforce knows' },
        parent: { sobject: 'Campaign', name: 'Annual Plan' },
        businessUnit: { developerName: 'otherBusinessUnit' },
        brief: { sobject: 'Brief', name: 'Spring brief' },
      });
      const preview = await deployCampaigns(org.connection, { files: [path], preview: true });
      expect(preview).to.deep.equal([
        { area: 'mcnext', type: 'campaign', name: 'Spring Sale', outcome: 'would-create', path },
      ]);
      expect(org.creates).to.deep.equal([]);

      const items = await deployCampaigns(org.connection, { files: [path], preview: false });
      expect(items.map((item) => [item.outcome, item.id])).to.deep.equal([['created', org.campaigns[1].Id]]);
      // The stage is sent as authored: Salesforce decides whether it is a valid value.
      expect(org.creates).to.deep.equal([
        {
          Status: 'Planned',
          Stage: 'Not a stage Salesforce knows',
          Name: 'Spring Sale',
          ParentId: PLAN.Id,
          BriefId: BRIEFS[0].Id,
          BusinessUnitId: OTHER_UNIT,
        },
      ]);
    });

    it('lets the target business unit override the file', async () => {
      const dir = await project();
      const org = fakeOrg({});
      const path = await write(dir, { name: 'New', fields: {}, businessUnit: { developerName: 'noSuchUnit' } });
      const items = await deployCampaigns(org.connection, {
        files: [path],
        preview: false,
        targetBusinessUnit: { id: OTHER_UNIT, developerName: 'otherBusinessUnit' },
      });
      expect(items[0].outcome).to.equal('created');
      expect(org.creates[0].BusinessUnitId).to.equal(OTHER_UNIT);
    });

    it('updates only the fields that differ and never sends the business unit', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN, SPRING], briefs: BRIEFS });
      const path = await write(dir, {
        name: 'Spring Sale',
        fields: { Status: 'In Progress', Stage: 'In Planning', BudgetedCost: 1200.5 },
        parent: { sobject: 'Campaign', name: 'Annual Plan' },
        businessUnit: { developerName: 'otherBusinessUnit' },
      });
      const preview = await deployCampaigns(org.connection, { files: [path], preview: true });
      expect(preview.map((item) => [item.outcome, item.id])).to.deep.equal([['would-update', SPRING.Id]]);
      expect(org.updates).to.deep.equal([]);

      const items = await deployCampaigns(org.connection, { files: [path], preview: false });
      expect(items.map((item) => [item.outcome, item.id])).to.deep.equal([['updated', SPRING.Id]]);
      expect(org.updates).to.deep.equal([{ Id: SPRING.Id, Status: 'In Progress' }]);

      const again = await deployCampaigns(org.connection, { files: [path], preview: false });
      expect(again.map((item) => item.outcome)).to.deep.equal(['unchanged']);
      expect(org.updates).to.have.length(1);
    });

    it('updates a changed parent', async () => {
      const dir = await project();
      const other = { Id: '701000000000906AAA', Name: 'Other Plan' };
      const org = fakeOrg({ campaigns: [PLAN, SPRING, other], briefs: BRIEFS });
      const path = await write(dir, {
        name: 'Spring Sale',
        fields: {},
        parent: { sobject: 'Campaign', name: 'Other Plan' },
        ...IN_OTHER,
      });
      const items = await deployCampaigns(org.connection, { files: [path], preview: false });
      expect(items[0].outcome).to.equal('updated');
      expect(org.updates).to.deep.equal([{ Id: SPRING.Id, ParentId: other.Id }]);
    });

    it('blocks when several campaigns have the name, and matches the name exactly', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN, { ...PLAN, Id: '701000000000907AAA' }, { Id: '7019', Name: 'solo' }] });
      const ambiguous = await write(dir, { name: 'Annual Plan', fields: { Status: 'x' }, ...IN_DEFAULT });
      const otherCase = await write(dir, { name: 'SOLO', fields: {} });
      const items = await deployCampaigns(org.connection, { files: [otherCase, ambiguous], preview: false });
      expect(items.map((item) => [item.name, item.outcome, item.code])).to.deep.equal([
        ['SOLO', 'created', undefined],
        ['Annual Plan', 'blocked', 'CAMPAIGN_NAME_AMBIGUOUS'],
      ]);
      expect(items[1].message).to.include('in business unit defaultBusinessUnit');
      expect(org.updates).to.deep.equal([]);
      expect(await findCampaignsByName(org.connection, 'solo')).to.deep.equal([{ Id: '7019' }]);
      expect(await findCampaignsByName(org.connection, 'Annual Plan')).to.have.length(2);
    });

    it('blocks a parent, brief or business unit that does not exist before any write', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [SPRING, { Id: '7018', Name: 'Twin' }, { Id: '7017', Name: 'Twin' }] });
      const files = await Promise.all([
        write(dir, { name: 'A', fields: {}, parent: { sobject: 'Campaign', name: 'Nowhere' } }),
        write(dir, { name: 'B', fields: {}, brief: { sobject: 'Brief', name: 'Nowhere' } }),
        write(dir, { name: 'C', fields: {}, businessUnit: { developerName: 'noSuchUnit' } }),
        write(dir, { name: 'D', fields: {}, parent: { sobject: 'Campaign', name: 'Twin' } }),
        write(dir, { name: 'Spring Sale', fields: { Status: 'x' }, brief: { sobject: 'Brief', name: 'Nowhere' } }),
      ]);
      const expected = [
        ['A', 'blocked', 'CAMPAIGN_PARENT_NOT_FOUND'],
        ['B', 'blocked', 'CAMPAIGN_BRIEF_NOT_FOUND'],
        ['C', 'blocked', 'CAMPAIGN_BUSINESS_UNIT_NOT_FOUND'],
        ['D', 'blocked', 'CAMPAIGN_PARENT_AMBIGUOUS'],
        ['Spring Sale', 'blocked', 'CAMPAIGN_BRIEF_NOT_FOUND'],
      ];
      const preview = await deployCampaigns(org.connection, { files, preview: true });
      expect(preview.map((item) => [item.name, item.outcome, item.code])).to.deep.equal(expected);
      // A real run stops at its first blocked campaign, so each file gets its own run.
      for (const [index, file] of files.entries()) {
        // eslint-disable-next-line no-await-in-loop -- one run after the other
        const items = await deployCampaigns(org.connection, { files: [file], preview: false });
        expect(items.map((item) => [item.name, item.outcome, item.code])).to.deep.equal([expected[index]]);
      }
      expect(org.creates).to.deep.equal([]);
      expect(org.updates).to.deep.equal([]);
    });

    it('writes a parent of the same run first and counts it in a preview', async () => {
      const dir = await project();
      const org = fakeOrg({});
      const child = await write(dir, { name: 'Child', fields: {}, parent: { sobject: 'Campaign', name: 'Parent' } });
      const parent = await write(dir, { name: 'Parent', fields: {} });
      const preview = await deployCampaigns(org.connection, { files: [child, parent], preview: true });
      expect(preview.map((item) => [item.name, item.outcome])).to.deep.equal([
        ['Child', 'would-create'],
        ['Parent', 'would-create'],
      ]);
      expect(preview[0].message).to.include('created in this run');

      const items = await deployCampaigns(org.connection, { files: [child, parent], preview: false });
      expect(items.map((item) => [item.name, item.outcome])).to.deep.equal([
        ['Child', 'created'],
        ['Parent', 'created'],
      ]);
      expect(org.creates.map((record) => record.Name)).to.deep.equal(['Parent', 'Child']);
      expect(org.creates[1].ParentId).to.equal(org.campaigns[0].Id);
    });

    it('does not count a blocked parent of the same run', async () => {
      const dir = await project();
      const org = fakeOrg({});
      const child = await write(dir, { name: 'Child', fields: {}, parent: { sobject: 'Campaign', name: 'Parent' } });
      const parent = await write(dir, { name: 'Parent', fields: {}, brief: { sobject: 'Brief', name: 'Nowhere' } });
      const preview = await deployCampaigns(org.connection, { files: [child, parent], preview: true });
      expect(preview.map((item) => item.code)).to.deep.equal(['CAMPAIGN_PARENT_NOT_FOUND', 'CAMPAIGN_BRIEF_NOT_FOUND']);
    });

    it('takes a campaign of the same name in another business unit, or in none, as another campaign', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN, SPRING], briefs: BRIEFS });
      // "Spring Sale" exists in otherBusinessUnit only; "Annual Plan" in defaultBusinessUnit only.
      const inDefault = await write(dir, { name: 'Spring Sale', fields: { Status: 'Changed' }, ...IN_DEFAULT });
      const none = await write(dir, { name: 'Annual Plan', fields: { Status: 'Changed' } });
      const preview = await deployCampaigns(org.connection, { files: [inDefault, none], preview: true });
      expect(preview.map((item) => [item.outcome, item.id, item.code])).to.deep.equal([
        ['would-create', undefined, undefined],
        ['would-create', undefined, undefined],
      ]);
      expect(
        org.queries.some((soql) => soql.includes(`Name = 'Spring Sale' AND BusinessUnitId = '${DEFAULT_UNIT}'`))
      ).to.equal(true);
      expect(org.queries.some((soql) => soql.includes("Name = 'Annual Plan' AND BusinessUnitId = null"))).to.equal(
        true
      );

      const items = await deployCampaigns(org.connection, { files: [inDefault, none], preview: false });
      expect(items.map((item) => item.outcome)).to.deep.equal(['created', 'created']);
      expect(org.creates).to.deep.equal([
        { Status: 'Changed', Name: 'Spring Sale', BusinessUnitId: DEFAULT_UNIT },
        { Status: 'Changed', Name: 'Annual Plan' },
      ]);
      expect(org.updates).to.deep.equal([]);
      // Now each name exists twice in the org, and each file still finds its own campaign.
      const again = await deployCampaigns(org.connection, { files: [inDefault, none], preview: false });
      expect(again.map((item) => [item.outcome, item.id])).to.deep.equal([
        ['unchanged', org.campaigns[2].Id],
        ['unchanged', org.campaigns[3].Id],
      ]);
    });

    it('copies into the target business unit under the same name and updates the copy there afterwards', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN] });
      const path = await write(dir, { name: 'Annual Plan', fields: { Status: 'Planned' }, ...IN_DEFAULT });
      const targetBusinessUnit = { id: OTHER_UNIT, developerName: 'otherBusinessUnit' };
      const copied = await deployCampaigns(org.connection, { files: [path], preview: false, targetBusinessUnit });
      expect(copied.map((item) => item.outcome)).to.deep.equal(['created']);
      expect(org.creates).to.deep.equal([{ Status: 'Planned', Name: 'Annual Plan', BusinessUnitId: OTHER_UNIT }]);
      const again = await deployCampaigns(org.connection, { files: [path], preview: true, targetBusinessUnit });
      expect(again.map((item) => [item.outcome, item.id])).to.deep.equal([['unchanged', org.campaigns[1].Id]]);
      // The source campaign is the one found without a target.
      const source = await deployCampaigns(org.connection, { files: [path], preview: true });
      expect(source.map((item) => [item.outcome, item.id])).to.deep.equal([['unchanged', PLAN.Id]]);
      expect(org.updates).to.deep.equal([]);
    });

    it('blocks a file whose folder and business unit disagree, before the org is read for it', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN] });
      const flat = campaignPath(dir, 'Annual Plan');
      const wrongUnit = campaignPath(dir, 'Other Plan', 'otherBusinessUnit');
      const noUnit = campaignPath(dir, 'Solo', 'otherBusinessUnit');
      await mkdir(dirname(wrongUnit), { recursive: true });
      await writeFile(flat, serializeCampaignFile({ name: 'Annual Plan', fields: {}, ...IN_DEFAULT }), 'utf8');
      await writeFile(wrongUnit, serializeCampaignFile({ name: 'Other Plan', fields: {}, ...IN_DEFAULT }), 'utf8');
      await writeFile(noUnit, serializeCampaignFile({ name: 'Solo', fields: {} }), 'utf8');
      const items = await deployCampaigns(org.connection, { files: [flat, wrongUnit, noUnit], preview: true });
      expect(items.map((item) => [item.outcome, item.code])).to.deep.equal([
        ['blocked', 'CAMPAIGN_FILE_INVALID'],
        ['blocked', 'CAMPAIGN_FILE_INVALID'],
        ['blocked', 'CAMPAIGN_FILE_INVALID'],
      ]);
      expect(items[0].message).to.include('is not in a business unit folder');
      expect(items[1].message).to.include('is in the folder of otherBusinessUnit');
      expect(org.queries).to.deep.equal([]);
      const real = await deployCampaigns(org.connection, { files: [flat, noUnit], preview: false });
      expect(real.map((item) => item.outcome)).to.deep.equal(['blocked', 'not-attempted']);
      expect(org.creates).to.deep.equal([]);
    });

    it('blocks every file of a campaign that several files of the run stand for, before any write', async () => {
      const dir = await project();
      const org = fakeOrg({});
      const targetBusinessUnit = { id: OTHER_UNIT, developerName: 'otherBusinessUnit' };
      const solo = await write(dir, { name: 'Solo', fields: {} });
      const flat = await write(dir, { name: 'Twice', fields: { Status: 'A' } });
      const inDefault = await write(dir, { name: 'Twice', fields: { Status: 'B' }, ...IN_DEFAULT });
      const child = await write(dir, { name: 'Child', fields: {}, parent: { sobject: 'Campaign', name: 'Twice' } });
      const files = [solo, flat, inDefault, child];

      // Different business units: two campaigns.
      const apart = await deployCampaigns(org.connection, { files: [flat, inDefault], preview: true });
      expect(apart.map((item) => item.outcome)).to.deep.equal(['would-create', 'would-create']);

      // Every file goes to the target business unit: the two are one campaign there.
      const preview = await deployCampaigns(org.connection, { files, preview: true, targetBusinessUnit });
      expect(preview.map((item) => [item.name, item.outcome, item.code, item.path])).to.deep.equal([
        ['Solo', 'would-create', undefined, solo],
        ['Twice', 'blocked', 'CAMPAIGN_NAME_AMBIGUOUS', flat],
        ['Twice', 'blocked', 'CAMPAIGN_NAME_AMBIGUOUS', inDefault],
        ['Child', 'blocked', 'CAMPAIGN_PARENT_NOT_FOUND', child],
      ]);
      expect(preview[1].message)
        .to.include(flat)
        .and.to.include(inDefault)
        .and.to.include('in business unit otherBusinessUnit')
        .and.to.include('--source-dir');

      const items = await deployCampaigns(org.connection, { files, preview: false, targetBusinessUnit });
      expect(items.map((item) => [item.name, item.outcome])).to.deep.equal([
        ['Solo', 'not-attempted'],
        ['Twice', 'blocked'],
        ['Twice', 'blocked'],
        ['Child', 'not-attempted'],
      ]);

      // An org without business units knows the name only.
      const plain = fakeOrg({ fields: DISABLED_FIELDS });
      const noUnits = await deployCampaigns(plain.connection, { files: [flat, inDefault], preview: false });
      expect(noUnits.map((item) => [item.outcome, item.code])).to.deep.equal([
        ['blocked', 'CAMPAIGN_NAME_AMBIGUOUS'],
        ['blocked', 'CAMPAIGN_NAME_AMBIGUOUS'],
      ]);
      expect(noUnits[0].message).to.not.include('business unit');
      for (const fake of [org, plain]) {
        expect(fake.creates).to.deep.equal([]);
        expect(fake.updates).to.deep.equal([]);
      }
    });

    it('blocks a file whose fields hold a lookup or the owner or record type, and sends nothing', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN] });
      const refused: Array<[string, string]> = [
        ['BusinessUnitId', '"businessUnit"'],
        ['ParentId', '"parent"'],
        ['briefid', '"brief"'],
        ['OwnerId', 'owner'],
        ['RecordTypeId', 'record type'],
      ];
      const files: string[] = [];
      for (const [field] of refused) {
        // eslint-disable-next-line no-await-in-loop -- small fixture loop
        files.push(await write(dir, { name: `New ${field}`, fields: { Status: 'x', [field]: OTHER_UNIT } }));
      }
      files.push(await write(dir, { name: 'Annual Plan', fields: { ParentId: PLAN.Id }, ...IN_DEFAULT }));
      const preview = await deployCampaigns(org.connection, { files, preview: true });
      expect(preview.map((item) => [item.outcome, item.code])).to.deep.equal(
        files.map(() => ['blocked', 'CAMPAIGN_FILE_INVALID'])
      );
      for (const [index, [field, instead]] of refused.entries())
        expect(preview[index].message).to.include(`"fields.${field}"`).and.to.include(instead);
      expect(org.queries).to.deep.equal([]);
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop -- one run per file: a run stops at its first blocked campaign
        const items = await deployCampaigns(org.connection, { files: [file], preview: false });
        expect(items.map((item) => item.code)).to.deep.equal(['CAMPAIGN_FILE_INVALID']);
      }
      expect(org.creates).to.deep.equal([]);
      expect(org.updates).to.deep.equal([]);
    });

    it('takes the parent from the same business unit first, then from this run, then from the whole org', async () => {
      const dir = await project();
      const otherPlan = { ...PLAN, Id: '701000000000911AAA', BusinessUnitId: OTHER_UNIT };
      const org = fakeOrg({ campaigns: [PLAN, otherPlan, { Id: '701000000000912AAA', Name: 'Elsewhere' }] });
      const parent = { sobject: 'Campaign', name: 'Annual Plan' } as const;
      // Two campaigns are named "Annual Plan"; the child takes the one of its own business unit.
      const sameUnit = await write(dir, { name: 'Child', fields: {}, parent, ...IN_OTHER });
      // No "Elsewhere" in otherBusinessUnit: the one campaign of that name in the org.
      const fallback = await write(dir, {
        name: 'Second',
        fields: {},
        parent: { ...parent, name: 'Elsewhere' },
        ...IN_OTHER,
      });
      // No "Annual Plan" without a business unit, and two in the org.
      const ambiguous = await write(dir, { name: 'Third', fields: {}, parent });
      const preview = await deployCampaigns(org.connection, { files: [sameUnit, fallback, ambiguous], preview: true });
      expect(preview.map((item) => [item.name, item.outcome, item.code])).to.deep.equal([
        ['Child', 'would-create', undefined],
        ['Second', 'would-create', undefined],
        ['Third', 'blocked', 'CAMPAIGN_PARENT_AMBIGUOUS'],
      ]);
      await deployCampaigns(org.connection, { files: [sameUnit, fallback], preview: false });
      expect(org.creates.map((record) => [record.Name, record.ParentId])).to.deep.equal([
        ['Child', otherPlan.Id],
        ['Second', '701000000000912AAA'],
      ]);

      // A parent this run writes into the same business unit comes before one elsewhere in the org.
      const newParent = await write(dir, { name: 'Elsewhere', fields: {}, ...IN_DEFAULT });
      const newChild = await write(dir, {
        name: 'Fourth',
        fields: {},
        parent: { ...parent, name: 'Elsewhere' },
        ...IN_DEFAULT,
      });
      const pending = await deployCampaigns(org.connection, { files: [newChild, newParent], preview: true });
      expect(pending.map((item) => item.outcome)).to.deep.equal(['would-create', 'would-create']);
      expect(pending[0].message).to.include('created in this run');
      const written = await deployCampaigns(org.connection, { files: [newChild, newParent], preview: false });
      expect(written.map((item) => item.outcome)).to.deep.equal(['created', 'created']);
      expect(org.creates.at(-1)?.ParentId).to.equal(
        org.campaigns.find((row) => row.Name === 'Elsewhere' && row.BusinessUnitId === DEFAULT_UNIT)?.Id
      );
    });
    it('ignores the business unit in an org without the feature and says so', async () => {
      const dir = await project();
      const org = fakeOrg({ fields: DISABLED_FIELDS, campaigns: [{ Id: '7016', Name: 'Old', Status: 'Planned' }] });
      const created = await write(dir, {
        name: 'New',
        fields: { Status: 'Planned' },
        businessUnit: { developerName: 'otherBusinessUnit' },
      });
      const updated = await write(dir, { name: 'Old', fields: { Status: 'Done' } });
      const items = await deployCampaigns(org.connection, {
        files: [created, updated],
        preview: false,
        targetBusinessUnit: { id: OTHER_UNIT, developerName: 'otherBusinessUnit' },
      });
      expect(items.map((item) => item.outcome)).to.deep.equal(['created', 'updated']);
      for (const item of items) expect(item.message).to.include('does not use business units');
      expect(org.creates).to.deep.equal([{ Status: 'Planned', Name: 'New' }]);
      expect(org.updates).to.deep.equal([{ Id: '7016', Status: 'Done' }]);
      expect(org.queries.join(' ')).to.not.include('BusinessUnit');
    });

    it("reports Salesforce's refusal verbatim as failed", async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN] });
      const created = await write(dir, { name: 'New', fields: { Stage: 'Nope' } });
      const updated = await write(dir, { name: 'Annual Plan', fields: { NoSuchField: 1 }, ...IN_DEFAULT });
      org.onWrite = (kind) => {
        if (kind === 'update')
          return {
            success: false,
            errors: [
              { statusCode: 'INVALID_FIELD', message: "No such column 'NoSuchField' on sobject of type Campaign" },
            ],
          };
        throw Object.assign(new Error('Stage: bad value for restricted picklist field: Nope'), {
          errorCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
        });
      };
      // One run per file: a run stops at its first failed campaign.
      const items = [
        ...(await deployCampaigns(org.connection, { files: [created], preview: false })),
        ...(await deployCampaigns(org.connection, { files: [updated], preview: false })),
      ];
      expect(items.map((item) => [item.outcome, item.code, item.message])).to.deep.equal([
        ['failed', 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', 'Stage: bad value for restricted picklist field: Nope'],
        ['failed', 'INVALID_FIELD', "No such column 'NoSuchField' on sobject of type Campaign"],
      ]);
      // The unknown field was sent, not filtered out locally.
      expect(org.updates).to.deep.equal([{ Id: PLAN.Id, NoSuchField: 1 }]);
    });

    it('reports a write without an answer as unknown and does not send it again', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN] });
      const created = await write(dir, { name: 'New', fields: {} });
      const updated = await write(dir, { name: 'Annual Plan', fields: { Status: 'Changed' }, ...IN_DEFAULT });
      org.onWrite = (kind) => {
        if (kind === 'create') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        throw Object.assign(new Error('Gateway Timeout'), { errorCode: 'ERROR_HTTP_504' });
      };
      // One run per file: a run stops at its first unknown campaign.
      const items = [
        ...(await deployCampaigns(org.connection, { files: [created], preview: false })),
        ...(await deployCampaigns(org.connection, { files: [updated], preview: false })),
      ];
      expect(items.map((item) => [item.outcome, item.code])).to.deep.equal([
        ['unknown', 'CAMPAIGN_WRITE_UNKNOWN'],
        ['unknown', 'CAMPAIGN_WRITE_UNKNOWN'],
      ]);
      expect(items[0].message).to.include('socket hang up');
      expect(items[1].id).to.equal(PLAN.Id);
      expect(org.creates).to.have.length(1);
      expect(org.updates).to.have.length(1);
    });

    it('returns failed items for an unreadable file or org, without a write', async () => {
      const dir = await project();
      const org = fakeOrg({});
      const good = await write(dir, { name: 'Good', fields: {} });
      const bad = join(dir, 'mcnext', 'campaigns', 'Bad.campaign.json');
      await writeFile(bad, '{', 'utf8');
      org.failQuery = 'FROM Campaign';
      // A preview checks every file.
      const items = await deployCampaigns(org.connection, { files: [bad, good], preview: true });
      expect(items.map((item) => [item.name, item.outcome, item.code, item.path])).to.deep.equal([
        ['Bad', 'failed', 'CAMPAIGN_FILE_INVALID', bad],
        ['Good', 'failed', 'CAMPAIGN_READ_FAILED', good],
      ]);
      // A real run stops at the unreadable file.
      const stopped = await deployCampaigns(org.connection, { files: [bad, good], preview: false });
      expect(stopped.map((item) => [item.name, item.outcome, item.path])).to.deep.equal([
        ['Bad', 'failed', bad],
        ['Good', 'not-attempted', good],
      ]);
      org.failDescribe = true;
      const noDescribe = await deployCampaigns(org.connection, { files: [bad, good], preview: false });
      expect(noDescribe.map((item) => item.code)).to.deep.equal(['CAMPAIGN_FILE_INVALID', 'CAMPAIGN_READ_FAILED']);
      expect(org.creates).to.deep.equal([]);
    });

    it('stops a real run at the first problem, parent before child, and reports the rest as not-attempted', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN] });
      const first = await write(dir, { name: 'First', fields: {} });
      const child = await write(dir, { name: 'Child', fields: {}, parent: { sobject: 'Campaign', name: 'Parent' } });
      const parent = await write(dir, { name: 'Parent', fields: { Stage: 'Nope' } });
      const last = await write(dir, { name: 'Annual Plan', fields: { Status: 'Changed' }, ...IN_DEFAULT });
      const files = [first, child, parent, last];
      org.onWrite = () =>
        org.creates.length === 1 ? undefined : { success: false, errors: [{ statusCode: 'INVALID', message: 'no' }] };

      // The parent is written before its child, fails, and nothing after it is sent.
      const items = await deployCampaigns(org.connection, { files, preview: false });
      expect(items.map((item) => [item.name, item.outcome, item.path])).to.deep.equal([
        ['First', 'created', first],
        ['Child', 'not-attempted', child],
        ['Parent', 'failed', parent],
        ['Annual Plan', 'not-attempted', last],
      ]);
      expect(org.creates.map((row) => row.Name)).to.deep.equal(['First', 'Parent']);
      expect(org.updates).to.deep.equal([]);

      // A blocked campaign stops the run as well; a preview still checks every file.
      const orphan = await write(dir, { name: 'Orphan', fields: {}, parent: { sobject: 'Campaign', name: 'Nowhere' } });
      const blocked = await deployCampaigns(org.connection, { files: [orphan, last], preview: false });
      expect(blocked.map((item) => item.outcome)).to.deep.equal(['blocked', 'not-attempted']);
      const preview = await deployCampaigns(org.connection, { files: [orphan, last], preview: true });
      expect(preview.map((item) => item.outcome)).to.deep.equal(['blocked', 'would-update']);
      expect(org.updates).to.deep.equal([]);
    });

    for (const [kind, fields] of [
      ['with business units', undefined],
      ['without business units', DISABLED_FIELDS],
    ] as const) {
      it(`round trip in an org ${kind}: retrieve, then deploy is unchanged`, async () => {
        const dir = await project();
        const campaigns = [PLAN, SPRING, { Id: '7015', Name: 'A/B: 50%' }].map(
          (row): Row => Object.fromEntries(Object.entries(row).filter(([key]) => !fields || key !== 'BusinessUnitId'))
        );
        const org = fakeOrg({ fields, campaigns, briefs: BRIEFS });
        const retrieved = await retrieveCampaigns(org.connection, { outputDir: dir });
        expect(retrieved.map((item) => item.outcome)).to.deep.equal(['retrieved', 'retrieved', 'retrieved']);
        const files = retrieved.map((item) => item.path as string);
        for (const preview of [true, false]) {
          // eslint-disable-next-line no-await-in-loop -- two runs, one after the other
          const items = await deployCampaigns(org.connection, { files, preview });
          expect(items.map((item) => [item.name, item.outcome, item.id])).to.deep.equal(
            campaigns.map((campaign) => [campaign.Name, 'unchanged', campaign.Id])
          );
        }
        expect(org.creates).to.deep.equal([]);
        expect(org.updates).to.deep.equal([]);
      });
    }
  });

  describe('remove', () => {
    it('deletes the record, then the local file', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN] });
      const path = await write(dir, { name: 'Annual Plan', fields: {}, ...IN_DEFAULT });
      const preview = await removeCampaigns(org.connection, {
        campaigns: [{ name: 'Annual Plan' }],
        preview: true,
        projectDir: dir,
        keepLocalFiles: false,
      });
      expect(preview).to.deep.equal([
        { area: 'mcnext', type: 'campaign', name: 'Annual Plan', outcome: 'would-delete', id: PLAN.Id, path },
      ]);
      expect(org.destroys).to.deep.equal([]);
      expect(await exists(path)).to.equal(true);

      const items = await removeCampaigns(org.connection, {
        campaigns: [{ name: 'Annual Plan' }],
        preview: false,
        projectDir: dir,
        keepLocalFiles: false,
      });
      expect(items).to.deep.equal([
        { area: 'mcnext', type: 'campaign', name: 'Annual Plan', outcome: 'deleted', id: PLAN.Id, path },
      ]);
      expect(org.destroys).to.deep.equal([PLAN.Id]);
      expect(org.campaigns).to.deep.equal([]);
      expect(await exists(path)).to.equal(false);
    });

    it('keeps the local file when asked, and does not mind a missing one', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN, { Id: '7014', Name: 'No file' }] });
      const path = await write(dir, { name: 'Annual Plan', fields: {}, ...IN_DEFAULT });
      const kept = await removeCampaigns(org.connection, {
        campaigns: [{ name: 'Annual Plan' }],
        preview: false,
        projectDir: dir,
        keepLocalFiles: true,
      });
      expect(kept[0].outcome).to.equal('deleted');
      expect(await exists(path)).to.equal(true);
      const noFile = await removeCampaigns(org.connection, {
        campaigns: [{ name: 'No file' }],
        preview: false,
        projectDir: dir,
        keepLocalFiles: false,
      });
      expect(noFile.map((item) => [item.outcome, item.message])).to.deep.equal([['deleted', undefined]]);
    });

    it('leaves a missing campaign unchanged and blocks an ambiguous name', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN, { ...PLAN, Id: '7013' }] });
      const path = await write(dir, { name: 'Gone', fields: {} });
      const items = await removeCampaigns(org.connection, {
        campaigns: [{ name: 'Gone' }, { name: 'Annual Plan' }],
        preview: false,
        projectDir: dir,
        keepLocalFiles: false,
      });
      expect(items.map((item) => [item.name, item.outcome, item.code])).to.deep.equal([
        ['Gone', 'unchanged', undefined],
        ['Annual Plan', 'blocked', 'CAMPAIGN_NAME_AMBIGUOUS'],
      ]);
      expect(org.destroys).to.deep.equal([]);
      expect(await exists(path)).to.equal(true);
    });

    it('keeps the local file when Salesforce refuses or does not answer', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN, SPRING], briefs: BRIEFS });
      const plan = await write(dir, { name: 'Annual Plan', fields: {}, ...IN_DEFAULT });
      const spring = await write(dir, { name: 'Spring Sale', fields: {}, ...IN_OTHER });
      let calls = 0;
      org.onWrite = () => {
        calls += 1;
        if (calls === 1) return { success: false, errors: [{ errorCode: 'DELETE_FAILED', message: 'Has children' }] };
        throw new Error('network timeout at: https://org.example');
      };
      // One run per campaign: a run stops at its first failed or unknown campaign.
      const removeOne = (name: string) =>
        removeCampaigns(org.connection, {
          campaigns: [{ name }],
          preview: false,
          projectDir: dir,
          keepLocalFiles: false,
        });
      const items = [...(await removeOne('Annual Plan')), ...(await removeOne('Spring Sale'))];
      expect(items.map((item) => [item.outcome, item.code])).to.deep.equal([
        ['failed', 'DELETE_FAILED'],
        ['unknown', 'CAMPAIGN_WRITE_UNKNOWN'],
      ]);
      expect(items[0].message).to.equal('Has children');
      expect(org.destroys).to.have.length(2);
      expect(await exists(plan)).to.equal(true);
      expect(await exists(spring)).to.equal(true);
    });

    it('removes the file the campaign was selected from, not the file named after the campaign', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN] });
      // B.campaign.json is another component's file; A.campaign.json holds the campaign "B".
      const other = await write(dir, { name: 'B', fields: { Status: 'Keep' } });
      const selected = join(dirname(other), 'A.campaign.json');
      await writeFile(selected, serializeCampaignFile({ name: 'B', fields: {} }), 'utf8');
      const options = { campaigns: [{ name: 'B', path: selected }], projectDir: dir, keepLocalFiles: false };

      // The org has no campaign "B": unchanged, and no file is touched.
      const unchanged = await removeCampaigns(org.connection, { ...options, preview: false });
      expect(unchanged.map((item) => [item.outcome, item.path])).to.deep.equal([['unchanged', selected]]);
      expect(await exists(selected)).to.equal(true);

      org.campaigns.push({ Id: '7019', Name: 'B' });
      const preview = await removeCampaigns(org.connection, { ...options, preview: true });
      expect(preview.map((item) => item.outcome)).to.deep.equal(['would-delete']);
      expect(await exists(selected)).to.equal(true);

      const items = await removeCampaigns(org.connection, { ...options, preview: false });
      expect(items.map((item) => [item.outcome, item.path])).to.deep.equal([['deleted', selected]]);
      expect(org.destroys).to.deep.equal(['7019']);
      expect(await exists(selected)).to.equal(false);
      expect(await exists(other)).to.equal(true);
    });

    it('stops at the first campaign with a problem and reports the rest as not-attempted', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN, SPRING, { Id: '7018', Name: 'Twin' }, { Id: '7017', Name: 'Twin' }] });
      const spring = await write(dir, { name: 'Spring Sale', fields: {}, ...IN_OTHER });
      const plan = await write(dir, { name: 'Annual Plan', fields: {}, ...IN_DEFAULT });
      const campaigns = [{ name: 'Spring Sale' }, { name: 'Twin' }, { name: 'Annual Plan' }];
      const preview = await removeCampaigns(org.connection, {
        campaigns,
        preview: true,
        projectDir: dir,
        keepLocalFiles: false,
      });
      expect(preview.map((item) => item.outcome)).to.deep.equal(['would-delete', 'blocked', 'would-delete']);
      const items = await removeCampaigns(org.connection, {
        campaigns,
        preview: false,
        projectDir: dir,
        keepLocalFiles: false,
      });
      expect(items.map((item) => [item.name, item.outcome])).to.deep.equal([
        ['Spring Sale', 'deleted'],
        ['Twin', 'blocked'],
        ['Annual Plan', 'not-attempted'],
      ]);
      expect(org.destroys).to.deep.equal([SPRING.Id]);
      expect(await exists(spring)).to.equal(false);
      expect(await exists(plan)).to.equal(true);
    });

    it('deletes the campaign of the business unit its local file names, and leaves its namesakes', async () => {
      const dir = await project();
      const other = { ...PLAN, Id: '701000000000913AAA', BusinessUnitId: OTHER_UNIT };
      const none = { Id: '701000000000914AAA', Name: 'Annual Plan' };
      const org = fakeOrg({ campaigns: [PLAN, other, none] });
      const options = { projectDir: dir, keepLocalFiles: false };
      const byName = [{ name: 'Annual Plan' }];

      // No local file, and three campaigns of that name in the org: which one is not clear.
      const noFile = await removeCampaigns(org.connection, { ...options, campaigns: byName, preview: false });
      expect(noFile.map((item) => [item.outcome, item.code])).to.deep.equal([['blocked', 'CAMPAIGN_NAME_AMBIGUOUS']]);
      expect(noFile[0].message).to.include('--source-dir');

      // One local file of that name: its business unit says which one.
      const inOther = await write(dir, { name: 'Annual Plan', fields: {}, ...IN_OTHER });
      const one = await removeCampaigns(org.connection, { ...options, campaigns: byName, preview: true });
      expect(one).to.deep.equal([
        { area: 'mcnext', type: 'campaign', name: 'Annual Plan', outcome: 'would-delete', id: other.Id, path: inOther },
      ]);

      // Local files of that name in several places: the file has to be selected.
      const flat = await write(dir, { name: 'Annual Plan', fields: {} });
      const several = await removeCampaigns(org.connection, { ...options, campaigns: byName, preview: false });
      expect(several.map((item) => [item.outcome, item.code])).to.deep.equal([['blocked', 'CAMPAIGN_NAME_AMBIGUOUS']]);
      expect(several[0].message).to.include(inOther).and.to.include(flat).and.to.include('--source-dir');
      expect(org.destroys).to.deep.equal([]);

      // Selected by file: the file without a business unit is the campaign without one.
      const selected = await removeCampaigns(org.connection, {
        ...options,
        campaigns: [{ name: 'Annual Plan', path: flat }],
        preview: false,
      });
      expect(selected.map((item) => [item.outcome, item.id, item.path])).to.deep.equal([['deleted', none.Id, flat]]);
      expect(await exists(flat)).to.equal(false);
      expect(await exists(inOther)).to.equal(true);
      // With one file left, the name is clear again.
      const last = await removeCampaigns(org.connection, { ...options, campaigns: byName, preview: false });
      expect(last.map((item) => [item.outcome, item.id])).to.deep.equal([['deleted', other.Id]]);
      expect(org.campaigns).to.deep.equal([PLAN]);
      expect(await exists(inOther)).to.equal(false);
    });

    it('reports a file whose business unit has no such campaign, is unknown or disagrees with its folder', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN] });
      const options = { projectDir: dir, keepLocalFiles: false, preview: false };
      const inOther = await write(dir, { name: 'Annual Plan', fields: {}, ...IN_OTHER });
      const missing = await removeCampaigns(org.connection, {
        ...options,
        campaigns: [{ name: 'Annual Plan', path: inOther }],
      });
      expect(missing.map((item) => item.outcome)).to.deep.equal(['unchanged']);
      expect(missing[0].message).to.include('in business unit otherBusinessUnit');

      const unknown = await write(dir, {
        name: 'Annual Plan',
        fields: {},
        businessUnit: { developerName: 'noSuchUnit' },
      });
      const noUnit = await removeCampaigns(org.connection, {
        ...options,
        campaigns: [{ name: 'Annual Plan', path: unknown }],
      });
      expect(noUnit.map((item) => [item.outcome, item.code])).to.deep.equal([
        ['blocked', 'CAMPAIGN_BUSINESS_UNIT_NOT_FOUND'],
      ]);

      const flat = campaignPath(dir, 'Annual Plan');
      await writeFile(flat, serializeCampaignFile({ name: 'Annual Plan', fields: {}, ...IN_DEFAULT }), 'utf8');
      const mismatch = await removeCampaigns(org.connection, {
        ...options,
        campaigns: [{ name: 'Annual Plan', path: flat }],
      });
      expect(mismatch.map((item) => [item.outcome, item.code])).to.deep.equal([['blocked', 'CAMPAIGN_FILE_INVALID']]);
      expect(org.destroys).to.deep.equal([]);
      expect(await exists(flat)).to.equal(true);
    });

    it('touches no local file when none was selected, also when a file differs from the name by case only', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [{ Id: '7011', Name: 'Plain' }] });
      // On a case-insensitive file system this file would answer to "Plain.campaign.json".
      const otherCase = await write(dir, { name: 'plain', fields: { Status: 'Keep' } });
      const items = await removeCampaigns(org.connection, {
        campaigns: [{ name: 'Plain' }],
        preview: false,
        projectDir: dir,
        keepLocalFiles: false,
      });
      expect(items).to.deep.equal([
        { area: 'mcnext', type: 'campaign', name: 'Plain', outcome: 'deleted', id: '7011' },
      ]);
      expect(await exists(otherCase)).to.equal(true);
    });

    it('blocks a file named after the campaign whose own name is another', async () => {
      const dir = await project();
      const org = fakeOrg({
        campaigns: [
          { Id: '7010', Name: 'Spring' },
          { Id: '7009', Name: 'Autumn' },
        ],
      });
      const path = campaignPath(dir, 'Spring');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, serializeCampaignFile({ name: 'Autumn', fields: {} }), 'utf8');
      for (const preview of [true, false]) {
        // eslint-disable-next-line no-await-in-loop -- two runs, one after the other
        const items = await removeCampaigns(org.connection, {
          campaigns: [{ name: 'Spring' }],
          preview,
          projectDir: dir,
          keepLocalFiles: false,
        });
        expect(items.map((item) => [item.name, item.outcome, item.code, item.path])).to.deep.equal([
          ['Spring', 'blocked', 'CAMPAIGN_FILE_INVALID', path],
        ]);
        expect(items[0].message).to.include('"Autumn"');
      }
      expect(org.destroys).to.deep.equal([]);
      expect(await exists(path)).to.equal(true);
    });

    it('goes by the name alone in an org without business units', async () => {
      const dir = await project();
      const org = fakeOrg({ fields: DISABLED_FIELDS, campaigns: [{ Id: '7012', Name: 'Plain' }] });
      const path = await write(dir, { name: 'Plain', fields: {}, ...IN_OTHER });
      const items = await removeCampaigns(org.connection, {
        campaigns: [{ name: 'Plain' }],
        preview: false,
        projectDir: dir,
        keepLocalFiles: false,
      });
      expect(items.map((item) => [item.outcome, item.id, item.path])).to.deep.equal([['deleted', '7012', path]]);
      expect(org.queries.join(' ')).to.not.include('BusinessUnit');
      expect(await exists(path)).to.equal(false);
    });

    it('returns a failed item when the org cannot be read', async () => {
      const dir = await project();
      const org = fakeOrg({ campaigns: [PLAN] });
      org.failQuery = 'FROM Campaign';
      const items = await removeCampaigns(org.connection, {
        campaigns: [{ name: 'Annual Plan' }],
        preview: false,
        projectDir: dir,
        keepLocalFiles: false,
      });
      expect(items.map((item) => [item.outcome, item.code])).to.deep.equal([['failed', 'CAMPAIGN_READ_FAILED']]);
      expect(org.destroys).to.deep.equal([]);
    });
  });
});
