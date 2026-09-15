import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { runCampaign, type CampaignSelection } from '../../src/core/campaignCli.js';
import { type CoreRunner } from '../../src/core/flowCli.js';

const id = '701000000000001AAA';
const sourceId = '701000000000002AAA';
const org = '00D000000000001AAA';
const record = {
  Id: id,
  Name: 'Target campaign',
  Type: 'Email',
  Status: 'Planned',
  IsActive: false,
  Description: 'Before',
  ParentId: null,
  RecordTypeId: null,
  OwnerId: '005000000000001AAA',
};
const definitions = ['Name', 'Type', 'Status', 'IsActive', 'Description'].map((name) => ({
  name,
  createable: true,
  updateable: true,
  length: 255,
  type: name === 'Type' || name === 'Status' ? 'picklist' : 'string',
  picklistValues: [{ value: name === 'Type' ? 'Email' : 'Planned', active: true }],
}));
const selection: CampaignSelection = {
  operation: 'update',
  projectRoot: '.',
  targetOrg: 'target',
  expectedOrgId: org,
  apiVersion: '67.0',
  recordId: id,
  expectedName: record.Name,
  artifact: { sourceId, fields: { Description: 'After' } },
};
const result = (value: unknown): { stdout: string; exitCode: number } => ({
  stdout: JSON.stringify({ status: 0, result: value }),
  exitCode: 0,
});
const rows = (records: unknown[]): unknown => ({ records, totalSize: records.length, done: true });
function transport(replies: unknown[], calls: string[][]): CoreRunner {
  return async (args) => {
    calls.push(args);
    return Promise.resolve(result(replies.shift()));
  };
}
async function rejects(s: CampaignSelection, replies: unknown[], message: string): Promise<string[][]> {
  const calls: string[][] = [];
  let error: unknown;
  try {
    await runCampaign(s, transport(replies, calls));
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).to.contain(message);
  return calls;
}
const description = { createable: true, updateable: true, fields: definitions };
const saved = { id, success: true, errors: [] };

describe('Campaign bounded Core configuration adapter', () => {
  it('uses direct GET records and lower-case SaveResult IDs, patch-only updates and preserved defaults', async () => {
    await Promise.all(
      [record, { ...record, Description: 'After' }].map(async (before) => {
        const calls: string[][] = [];
        const actual = await runCampaign(
          selection,
          transport(
            [
              rows([{ Id: org }]),
              description,
              before,
              saved,
              { ...record, Description: 'After', HierarchyActualCost: 0 },
            ],
            calls
          )
        );
        expect(actual.targetId).to.equal(id);
        expect(calls[3]).to.include('--record-id').and.include(id).and.include("Description='After'");
        expect(calls[3]).not.to.include('--where');
        for (const args of calls)
          expect(args)
            .to.include('--api-version')
            .and.include('67.0')
            .and.include('--target-org')
            .and.include('target');
      })
    );
  });
  it('exports only supported scalar configuration and rejects relationships', async () => {
    const s = { ...selection, operation: 'export' as const, artifact: undefined, expectedName: undefined };
    const exported = await runCampaign(
      s,
      transport([rows([{ Id: org }]), { ...record, Description: null, NumberSent: 3 }], [])
    );
    expect(exported.artifact.fields).to.deep.equal({
      Name: record.Name,
      Type: 'Email',
      Status: 'Planned',
      IsActive: false,
    });
    await rejects(s, [rows([{ Id: org }]), { ...record, ParentId: sourceId }], 'relationships');
    await rejects(s, [rows([{ Id: org }]), {}], 'malformed');
    await rejects(s, [rows([{ Id: org }]), { ...record, IsActive: 'false' }], 'malformed');
  });
  it('creates a distinct name, persists mapping before readback and refuses journal reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'campaign-test-'));
    try {
      const s: CampaignSelection = {
        ...selection,
        operation: 'create',
        projectRoot: root,
        recordId: undefined,
        expectedName: undefined,
        targetName: record.Name,
        journalFile: 'identity.json',
        artifact: { sourceId, fields: { ...record, Name: 'Source campaign' } },
      };
      s.artifact!.fields = {
        Name: 'Source campaign',
        Type: 'Email',
        Status: 'Planned',
        IsActive: false,
        Description: 'Before',
      };
      const calls: string[][] = [];
      const replies = [rows([{ Id: org }]), description, rows([]), saved, record];
      const runner: CoreRunner = async (args) => {
        if (args[1] === 'get')
          expect(JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'))).to.include({
            sourceId,
            targetId: id,
            state: 'created',
          });
        return transport(replies, calls)(args, root);
      };
      expect((await runCampaign(s, runner)).targetId).to.equal(id);
      expect(calls[3]).to.include(
        "Name='Target campaign' Type='Email' Status='Planned' IsActive=false Description='Before'"
      );
      expect(calls[3]).not.to.include('External_ID__c');
      await rejects(s, [rows([{ Id: org }]), description, rows([])], 'EEXIST');
      await rejects(
        { ...s, journalFile: 'other.json' },
        [rows([{ Id: org }]), description, rows([{ Id: id }])],
        'already exists'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects forbidden fields, unsupported relation mapping and ambiguous inputs before transport', async () => {
    await Promise.all(
      [
        { ParentId: id },
        { ['External_ID__c']: 'key' },
        { NumberSent: 1 },
        { Name: 'Rename' },
        { Description: null },
        { Description: "Quote's" },
        {},
      ].map(async (fields) => {
        expect(
          await rejects(
            { ...selection, artifact: { sourceId, fields } },
            [],
            fields.Description === null || typeof fields.Description === 'string'
              ? 'Unsupported value'
              : Object.keys(fields).length
              ? 'Unsupported Campaign field'
              : 'nonempty'
          )
        ).to.have.length(0);
      })
    );
    expect(await rejects({ ...selection, recordId: undefined }, [], 'Exact')).to.have.length(0);
    expect(await rejects({ ...selection, expectedName: undefined }, [], 'expected-name')).to.have.length(0);
  });
  it('rejects missing targets, nonwritable fields, bad picklists and mismatched orgs before mutation', async () => {
    await rejects(selection, [rows([])], 'identity mismatch');
    await rejects(selection, [rows([{ Id: org }]), description, {}], 'Missing');
    await rejects(selection, [rows([{ Id: org }]), description, { ...record, Name: 'Other' }], 'mismatch');
    await rejects(
      selection,
      [rows([{ Id: org }]), { ...description, fields: definitions.map((f) => ({ ...f, updateable: false })) }],
      'not target-writable'
    );
    await rejects(
      { ...selection, artifact: { sourceId, fields: { Type: 'Unknown' } } },
      [rows([{ Id: org }]), description],
      'picklist'
    );
  });
  it('fails closed on empty/malformed success, incomplete queries and ambiguous saves', async () => {
    await Promise.all(
      [undefined, {}, [], { records: [], totalSize: 1, done: true }].map(async (bad) =>
        rejects(selection, [bad], bad && !Array.isArray(bad) ? 'Incomplete' : 'malformed')
      )
    );
    await Promise.all(
      [
        {},
        { ...saved, success: false },
        { ...saved, errors: ['failure'] },
        { ...saved, id: sourceId },
        { ...saved, id: undefined, Id: id },
      ].map(async (bad) => rejects(selection, [rows([{ Id: org }]), description, record, bad], 'Ambiguous'))
    );
    await Promise.all(
      [
        { stdout: 'invalid', exitCode: 0 },
        { stdout: JSON.stringify({ status: 0, result: rows([{ Id: org }]) }), exitCode: 1 },
      ].map(async (response) => {
        let failed = false;
        try {
          await runCampaign(selection, async () => Promise.resolve(response));
        } catch {
          failed = true;
        }
        expect(failed).to.equal(true);
      })
    );
  });
  it('detects readback and unrelated supported configuration preservation failures', async () => {
    await rejects(selection, [rows([{ Id: org }]), description, record, saved, record], 'readback mismatch');
    await Promise.all(
      [{ Type: 'Other' }, { OwnerId: '005000000000002AAA' }, { ParentId: sourceId }].map(async (patch) =>
        rejects(
          selection,
          [rows([{ Id: org }]), description, record, saved, { ...record, Description: 'After', ...patch }],
          'preservation failed'
        )
      )
    );
  });
});
