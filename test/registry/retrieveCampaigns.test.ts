import filesystem, { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'chai';
import sinon from 'sinon';
import type { CoreProcessResult, CoreRunner } from '../../src/core/flowCli.js';
import { createRunOwnedDirectory, createRunOwnedTemp, type RunOwnedTemp } from '../../src/filesystem/runOwnedTemp.js';
import { retrieveCampaignSnapshots, type CampaignRetrievalContext } from '../../src/registry/retrieveCampaigns.js';

const orgId = '00D000000000001AAA';
const first = '701000000000001AAA';
const second = '701000000000002AAA';
const query = (records: unknown[]): Record<string, unknown> => ({ done: true, totalSize: records.length, records });
const success = (result: unknown): CoreProcessResult => ({
  stdout: JSON.stringify({ status: 0, result }),
  exitCode: 0,
});

describe('aggregate Campaign snapshots', () => {
  let owner: RunOwnedTemp;
  let context: CampaignRetrievalContext;
  let calls: string[][];
  let listing: unknown;
  let records: Record<string, Record<string, unknown>>;
  let runner: CoreRunner;
  let schemaFields: string[];
  let associatedSchema: boolean;
  let transportFailure: string | undefined;
  const destination = (name: string): string =>
    join(context.projectRoot, 'mcnext', 'campaigns', `${name}.mcn-campaign.json`);

  before(async () => {
    owner = await createRunOwnedTemp('mcnext-campaign-snapshot-tests');
  });
  beforeEach(async () => {
    const projectRoot = await createRunOwnedDirectory(owner, `project-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(projectRoot, 'native'));
    await writeFile(join(projectRoot, 'native', 'sentinel'), 'native\r\nbytes');
    await writeFile(
      join(projectRoot, 'sfdx-project.json'),
      '{"packageDirectories":[{"path":"native","default":true}]}\n'
    );
    context = { projectRoot, targetOrg: 'selected', expectedOrgId: orgId, apiVersion: '67.0' };
    calls = [];
    listing = query([{ Id: first }]);
    records = {
      [first]: {
        Id: first,
        Name: 'Exact Campaign',
        Description: null,
        ['Custom__c']: { value: null },
        OwnerId: '005000000000001AAA',
        attributes: { type: 'Campaign' },
      },
      [second]: { Id: second, Name: 'Second', Description: 'unchanged', ['Custom__c']: [null, 12], OwnerId: null },
    };
    schemaFields = ['Id', 'Name', 'Description', 'Custom__c', 'OwnerId'];
    associatedSchema = true;
    transportFailure = undefined;
    runner = async (args, cwd) => {
      calls.push(args);
      expect(cwd).to.equal(context.projectRoot);
      expect(args.slice(-5)).to.deep.equal(['--target-org', 'selected', '--api-version', '67.0', '--json']);
      const soql = args[args.indexOf('--query') + 1];
      if (transportFailure && args.includes(transportFailure)) throw new Error('INVALID_SESSION_ID token=secret');
      if (args[0] === 'sobject') {
        const name = args[args.indexOf('--sobject') + 1];
        return success({
          name,
          queryable: true,
          fields: (name === 'Campaign' ? schemaFields : ['Id', 'ApiName', 'AssociatedRecordId', 'SegmentId']).map(
            (field) => ({ name: field, type: 'string' })
          ),
          childRelationships: associatedSchema
            ? [{ relationshipName: 'Flows', childSObject: 'FlowRecord', field: 'AssociatedRecordId' }]
            : [],
        });
      }
      if (args.includes('--record-id')) return success(records[args[args.indexOf('--record-id') + 1]]);
      if (soql === 'SELECT Id FROM Organization') return success(query([{ Id: orgId }]));
      if (soql === 'SELECT Id FROM Campaign ORDER BY Id LIMIT 101') return success(listing);
      if (soql.includes('FROM FlowRecord')) return success(query([]));
      throw new Error(`Unexpected command ${JSON.stringify(args)}`);
    };
  });
  afterEach(async () => {
    sinon.restore();
    expect(await readFile(join(context.projectRoot, 'native', 'sentinel'), 'utf8')).to.equal('native\r\nbytes');
  });
  // Retain isolated OS-temp fixtures; no recursive cleanup or publication rollback.

  it('uses real runCampaign with fresh context, describe fields and original flat values', async () => {
    const result = await retrieveCampaignSnapshots(context, runner);
    expect(result.state).to.equal('success');
    expect(result.files).to.deep.equal([destination('Exact Campaign')]);
    const expected = {
      Id: first,
      ['Custom__c']: { value: null },
      Description: null,
      Name: 'Exact Campaign',
      OwnerId: '005000000000001AAA',
    };
    expect(await readFile(result.files[0], 'utf8')).to.equal(`${JSON.stringify(expected, undefined, 2)}\n`);
    expect(result.campaigns[0].result).to.deep.include({ artifact: expected });
    expect(result.campaigns[0].diagnostics.join(' ')).to.include('not a full backup');
    expect(calls.filter((args) => args.includes('SELECT Id FROM Organization'))).to.have.length(2);
    expect(calls[1][3]).to.equal('SELECT Id FROM Campaign ORDER BY Id LIMIT 101');
    expect(await readdir(join(context.projectRoot, 'mcnext', 'campaigns'))).to.deep.equal([
      'Exact Campaign.mcn-campaign.json',
    ]);
    expect(expected).not.to.have.keys('FlowId', 'SegmentId');
  });
  it('publishes every record from a complete multiple-row listing', async () => {
    listing = query([{ Id: first }, { Id: second }]);
    const result = await retrieveCampaignSnapshots(context, runner);
    expect(result.state).to.equal('success');
    expect(result.files).to.deep.equal([destination('Exact Campaign'), destination('Second')]);
    const saved = JSON.parse(await readFile(result.files[1], 'utf8')) as Record<string, unknown>;
    expect(saved['Custom__c']).to.deep.equal([null, 12]);
  });
  it('accepts zero accessible Campaigns without inventing output', async () => {
    listing = query([]);
    const result = await retrieveCampaignSnapshots(context, runner);
    expect(result).to.deep.equal({ state: 'success', files: [], campaigns: [], diagnostics: [] });
    expect(await readdir(context.projectRoot)).to.deep.equal(['native', 'sfdx-project.json']);
  });
  for (const [name, value] of [
    ['unfinished', { ...query([{ Id: first }]), done: false }],
    ['count mismatch', { ...query([{ Id: first }]), totalSize: 2 }],
    ['missing count', { records: [], done: true }],
    ['overflow', query(Array.from({ length: 101 }, (_, index) => ({ Id: `701${String(index).padStart(15, '0')}` })))],
    ['duplicate', query([{ Id: first }, { Id: first }])],
    ['unsafe identity', query([{ Id: '../escape' }])],
    ['15-character identity', query([{ Id: first.slice(0, 15) }])],
    ['wrong prefix', query([{ Id: `001${first.slice(3)}` }])],
    ['null row', query([null])],
    ['non-array records', { done: true, totalSize: 0, records: {} }],
  ] as Array<[string, unknown]>) {
    it(`blocks ${name} listing without partial selection or project writes`, async () => {
      listing = value;
      const result = await retrieveCampaignSnapshots(context, runner);
      expect(result.state).to.equal('blocked');
      expect(result.campaigns).to.deep.equal([]);
      expect(result.files).to.deep.equal([]);
      expect(calls).to.have.length(2);
      expect(await readdir(context.projectRoot)).to.deep.equal(['native', 'sfdx-project.json']);
    });
  }
  it('blocks fresh context mismatch before Campaign listing', async () => {
    const base = runner;
    runner = async (args, cwd) =>
      args.includes('SELECT Id FROM Organization') ? success(query([{ Id: '00DOther' }])) : base(args, cwd);
    const result = await retrieveCampaignSnapshots(context, runner);
    expect(result.state).to.equal('blocked');
    expect(result.campaigns).to.deep.equal([]);
  });
  it('blocks invalid API before Core calls', async () => {
    context.apiVersion = '66.0';
    expect((await retrieveCampaignSnapshots(context, runner)).state).to.equal('blocked');
    expect(calls).to.have.length(0);
  });
  it('rejects malformed envelopes and nonzero transport status', async () => {
    for (const response of [
      { stdout: '{', exitCode: 0 },
      { stdout: '{"status":0,"result":[]}', exitCode: 0 },
      { ...success(query([])), exitCode: 1 },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- independent malformed transport checks
      const result = await retrieveCampaignSnapshots(context, async () => response);
      expect(result.state).to.equal(response.exitCode === 0 ? 'blocked' : 'failed');
      expect(result.files).to.deep.equal([]);
    }
  });
  it('reports transport rejection as failed without leaking credentials', async () => {
    transportFailure = 'query';
    const result = await retrieveCampaignSnapshots(context, runner);
    expect(result.state).to.equal('failed');
    expect(JSON.stringify(result)).not.to.include('secret');
  });
  it('retains incomplete snapshot fields and diagnostics without upgrading them', async () => {
    schemaFields.push('Omitted__c');
    const result = await retrieveCampaignSnapshots(context, runner);
    expect(result.state).to.equal('partial');
    expect(result.campaigns[0].state).to.equal('partial');
    expect(result.campaigns[0].diagnostics.join(' ')).to.include('Omitted__c');
    expect(JSON.parse(await readFile(result.files[0], 'utf8'))).not.to.have.property('Omitted__c');
  });
  it('keeps blocked association evidence separate from a complete flat snapshot', async () => {
    associatedSchema = false;
    const result = await retrieveCampaignSnapshots(context, runner);
    expect(result.state).to.equal('success');
    const exported = result.campaigns[0].result;
    expect(exported?.operation === 'export' && exported.diagnostics.associatedArtifacts.status).to.equal('blocked');
    expect(result.files).to.have.length(1);
  });
  it('continues independent reads and publication after one Campaign fails', async () => {
    listing = query([{ Id: first }, { Id: second }]);
    records[first].Id = second;
    const result = await retrieveCampaignSnapshots(context, runner);
    expect(result.state).to.equal('partial');
    expect(result.campaigns.map((row) => row.state)).to.deep.equal(['failed', 'success']);
    expect(result.files).to.deep.equal([destination('Second')]);
  });
  for (const name of [
    '',
    '../escape',
    'a/b',
    'a\\b',
    'NUL',
    'NUL.json',
    'trailing.',
    'trailing ',
    'ads:stream',
    'bad?',
    'control\u0001',
  ]) {
    it(`blocks unsafe exact Name ${JSON.stringify(name)} before all publication`, async () => {
      listing = query([{ Id: second }, { Id: first }]);
      records[first].Name = name;
      const result = await retrieveCampaignSnapshots(context, runner);
      expect(result.state).to.equal('blocked');
      expect(result.files).to.deep.equal([]);
      expect(result.campaigns.every((row) => row.result !== undefined)).to.equal(true);
      expect(await readdir(context.projectRoot)).to.deep.equal(['native', 'sfdx-project.json']);
    });
  }
  for (const name of ['Exact Campaign', 'exact campaign', 'Ｅxact Campaign']) {
    it(`blocks duplicate/case/NFKC Name ${name} before writes`, async () => {
      listing = query([{ Id: first }, { Id: second }]);
      records[second].Name = name;
      expect((await retrieveCampaignSnapshots(context, runner)).state).to.equal('blocked');
      expect(await readdir(context.projectRoot)).to.deep.equal(['native', 'sfdx-project.json']);
    });
  }
  it('preserves existing destination sentinel, blocking the whole candidate set', async () => {
    await mkdir(join(context.projectRoot, 'mcnext', 'campaigns'), { recursive: true });
    await writeFile(destination('Second'), 'sentinel\r\n');
    listing = query([{ Id: first }, { Id: second }]);
    const result = await retrieveCampaignSnapshots(context, runner);
    expect(result.state).to.equal('blocked');
    expect(result.files).to.deep.equal([]);
    expect(await readFile(destination('Second'), 'utf8')).to.equal('sentinel\r\n');
  });
  it('rejects ancestor case aliases before Core effects', async () => {
    await mkdir(join(context.projectRoot, 'MCNEXT'));
    expect((await retrieveCampaignSnapshots(context, runner)).state).to.equal('blocked');
    expect(calls).to.have.length(0);
  });
  it('rejects junctions/links without writing their targets', async () => {
    const outside = await createRunOwnedDirectory(owner, `outside-${Math.random().toString(16).slice(2)}`);
    await symlink(outside, join(context.projectRoot, 'mcnext'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await retrieveCampaignSnapshots(context, runner)).state).to.equal('blocked');
    expect(await readdir(outside)).to.deep.equal([]);
  });
  for (const failure of ['open', 'write', 'close']) {
    for (const late of [false, true]) {
      it(`retains exact successful files on ${late ? 'late' : 'first'} ${failure} failure`, async () => {
        listing = query([{ Id: first }, { Id: second }]);
        const original = filesystem.open;
        sinon.stub(filesystem, 'open').callsFake(async (...args: Parameters<typeof filesystem.open>) => {
          const selected = String(args[0]) === destination(late ? 'Second' : 'Exact Campaign');
          if (selected && failure === 'open') throw new Error('open failed');
          const handle = await original(...args);
          if (selected && failure === 'write') sinon.stub(handle, 'writeFile').rejects(new Error('write failed'));
          if (selected && failure === 'close') {
            const close = handle.close.bind(handle);
            sinon.stub(handle, 'close').callsFake(async () => {
              await close();
              throw new Error('close failed');
            });
          }
          return handle;
        });
        const result = await retrieveCampaignSnapshots(context, runner);
        expect(result.state).to.equal(late ? 'partial' : 'failed');
        expect(result.files).to.deep.equal(late ? [destination('Exact Campaign')] : []);
        expect(result.campaigns.map((row) => row.files)).to.deep.equal(
          late ? [[destination('Exact Campaign')], []] : [[], []]
        );
        expect(result.diagnostics.join(' ')).to.include('Attempted output (not published)');
        expect(result.campaigns.map((row) => row.state)).to.deep.equal(
          late ? ['success', 'failed'] : ['failed', 'blocked']
        );
      });
    }
  }
});
