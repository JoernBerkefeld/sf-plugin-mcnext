import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'chai';
import { runCampaign, type CampaignSelection } from '../../src/core/campaignCli.js';
import { type CoreRunner } from '../../src/core/flowCli.js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
} from '../../src/filesystem/runOwnedTemp.js';

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
  BriefId: null,
  CampaignImageId: null,
  CampaignMemberRecordTypeId: null,
  OwnerId: '005000000000001AAA',
  StartDate: null,
  EndDate: null,
  CurrencyIsoCode: null,
  ExpectedRevenue: null,
  BudgetedCost: null,
  ActualCost: null,
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
  it('exports a describe-driven flat 79-field snapshot plus a custom field without losing values', async () => {
    const s = { ...selection, operation: 'export' as const, artifact: undefined, expectedName: undefined };
    const snapshot = {
      ...record,
      ...Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`Readable${i}__c`, i])),
      Description: null,
      Name: '',
      ParentId: sourceId,
      BriefId: '0gb000000000001AAA',
      CampaignImageId: '069000000000001AAA',
      ActualCost: 0,
      ['ExtraCustom__c']: {
        nested: [null, '', false, 0, {}, [], { label: 'keep', child: { value: 0 } }, [{ active: false }]],
        object: { text: '', nullable: null, empty: {}, list: [] },
      },
    };
    expect(Object.keys(snapshot)).to.have.length(80);
    const schema = {
      name: 'Campaign',
      queryable: true,
      fields: Object.keys(snapshot)
        .reverse()
        .map((name) => ({ name, type: 'string' })),
    };
    const calls: string[][] = [];
    const exported = await runCampaign(
      s,
      transport(
        [
          rows([{ Id: org }]),
          schema,
          {
            attributes: { type: 'Campaign' },
            ...snapshot,
            ['Undescribed__c']: 'exclude',
            ['ExtraCustom__c']: {
              attributes: { type: 'Compound' },
              nested: [
                null,
                '',
                false,
                0,
                { attributes: { type: 'Empty' } },
                [],
                {
                  attributes: { type: 'ArrayElement' },
                  label: 'keep',
                  child: { attributes: { type: 'Child' }, value: 0 },
                },
                [{ attributes: { type: 'NestedArrayElement' }, active: false }],
              ],
              object: {
                attributes: { type: 'Object' },
                text: '',
                nullable: null,
                empty: { attributes: { type: 'Empty' } },
                list: [],
              },
            },
          },
        ],
        calls
      )
    );
    expect(exported.artifact).to.deep.equal(snapshot);
    expect(exported.artifact).not.to.have.property('sourceId');
    expect(exported.artifact).not.to.have.property('fields');
    expect(exported.artifact).not.to.have.property('attributes');
    expect(Object.keys(exported.artifact)).to.deep.equal([
      'Id',
      ...Object.keys(snapshot)
        .filter((name) => name !== 'Id')
        .sort(),
    ]);
    expect(exported.operation).to.equal('export');
    if (exported.operation !== 'export') throw new Error('Expected export');
    expect(exported.diagnostics.snapshot).to.equal('complete');
    expect(exported.diagnostics.omittedFields).to.deep.equal([]);
    expect(exported.diagnostics.associatedArtifacts.status).to.equal('blocked');
    expect(calls.map((args) => args.slice(0, 2))).to.deep.equal([
      ['data', 'query'],
      ['sobject', 'describe'],
      ['data', 'get'],
    ]);
    expect(
      await rejects({ ...selection, artifact: snapshot as unknown as CampaignSelection['artifact'] }, [], 'nonempty')
    ).to.have.length(0);
  });
  it('distinguishes omitted readable fields from present null and empty values', async () => {
    const s = { ...selection, operation: 'export' as const, artifact: undefined, expectedName: undefined };
    const schema = {
      name: 'Campaign',
      queryable: true,
      fields: ['Id', 'Description', 'Name', 'PermissionField__c', 'NewApiField__c'].map((name) => ({
        name,
        type: 'string',
      })),
    };
    const exported = await runCampaign(
      s,
      transport(
        [rows([{ Id: org }]), schema, { Id: id, Description: null, Name: '', ['Unavailable__c']: 'not described' }],
        []
      )
    );
    expect(exported.artifact).to.deep.equal({ Id: id, Description: null, Name: '' });
    if (exported.operation !== 'export') throw new Error('Expected export');
    expect(exported.diagnostics.snapshot).to.equal('incomplete');
    expect(exported.diagnostics.omittedFields).to.deep.equal(['NewApiField__c', 'PermissionField__c']);
  });
  it('blocks invalid export schema and canonical identity before publishing a snapshot', async () => {
    const s = { ...selection, operation: 'export' as const, artifact: undefined, expectedName: undefined };
    const schema = { name: 'Campaign', queryable: true, fields: [{ name: 'Id', type: 'id' }] };
    await Promise.all(
      [
        {},
        { ...schema, name: 'Account' },
        { ...schema, queryable: false },
        { ...schema, fields: [] },
        { ...schema, fields: [{ name: 'Name', type: 'string' }] },
        { ...schema, fields: [schema.fields[0], schema.fields[0]] },
        { ...schema, fields: [{ name: 'Id FROM Account', type: 'id' }] },
        { ...schema, fields: [{ name: 'Id' }] },
      ].map(async (bad) => {
        expect(await rejects(s, [rows([{ Id: org }]), bad], 'schema')).to.have.length(2);
      })
    );
    await Promise.all(
      [{}, { Id: sourceId }, { Id: id.slice(0, 15) }].map(async (bad) =>
        rejects(s, [rows([{ Id: org }]), schema, bad], 'canonical identity')
      )
    );
    await rejects(s, [rows([{ Id: org }]), schema, []], 'malformed');
    await rejects(s, [{ records: [{ Id: org }], totalSize: 2, done: false }], 'Incomplete');
  });
  it('discovers zero and multiple flows with independent segments and distinct core/Tooling versions', async () => {
    const flowSchema = (name: string, names: string[]): unknown => ({
      name,
      queryable: true,
      fields: names.map((field) => ({ name: field, type: 'string' })),
    });
    const schema = {
      name: 'Campaign',
      queryable: true,
      fields: [{ name: 'Id', type: 'id' }],
      childRelationships: [{ relationshipName: 'Flows', childSObject: 'FlowRecord', field: 'AssociatedRecordId' }],
    };
    const coreSchema = flowSchema('FlowRecord', [
      'Id',
      'ApiName',
      'AssociatedRecordId',
      'SegmentId',
      'ActiveVersionId',
    ]);
    const s = { ...selection, operation: 'export' as const, artifact: undefined, expectedName: undefined };
    const zero = await runCampaign(s, transport([rows([{ Id: org }]), schema, { Id: id }, coreSchema, rows([])], []));
    if (zero.operation !== 'export') throw new Error('Expected export');
    expect(zero.diagnostics.associatedArtifacts).to.include({ status: 'complete' });
    expect(zero.diagnostics.associatedArtifacts.flows).to.deep.equal([]);
    const records = [1, 2].map((n) => ({
      Id: `2aF00000000000${n}AAA`,
      ApiName: `Flow_${n}`,
      AssociatedRecordId: id,
      SegmentId: `1sg00000000000${n}AAA`,
      ActiveVersionId: n === 1 ? '10v000000000001AAA' : null,
    }));
    const calls: string[][] = [];
    const actual = await runCampaign(
      s,
      transport(
        [
          rows([{ Id: org }]),
          schema,
          { Id: id },
          coreSchema,
          rows(records),
          flowSchema('FlowDefinition', ['Id', 'DeveloperName', 'ActiveVersionId', 'LatestVersionId']),
          flowSchema('Flow', ['Id', 'DefinitionId', 'Metadata']),
          ...records.flatMap((flow, i) => [
            rows([
              {
                Id: `30000000000000${i + 1}AAA`,
                DeveloperName: flow.ApiName,
                ActiveVersionId: null,
                LatestVersionId: `30100000000000${i + 1}AAA`,
              },
            ]),
            rows([
              {
                Id: `30100000000000${i + 1}AAA`,
                DefinitionId: `30000000000000${i + 1}AAA`,
                Metadata: { start: { triggerType: 'Segment', segment: `Audience_${i + 1}` } },
              },
            ]),
          ]),
        ],
        calls
      )
    );
    if (actual.operation !== 'export') throw new Error('Expected export');
    expect(actual.artifact).to.deep.equal({ Id: id });
    expect(actual.diagnostics.associatedArtifacts.status).to.equal('complete');
    expect(actual.diagnostics.associatedArtifacts.flows?.map((flow) => flow.record)).to.deep.equal(records);
    expect(actual.diagnostics.associatedArtifacts.flows?.map((flow) => flow.toolingFlow?.Id)).to.deep.equal([
      '301000000000001AAA',
      '301000000000002AAA',
    ]);
    expect(
      calls.some((args) => args.includes('--query') && args[args.indexOf('--query') + 1].includes("WHERE Id = '10v"))
    ).to.equal(false);
    expect(
      calls.every(
        (args) =>
          (args[0] === 'sobject' && args[1] === 'describe') ||
          (args[0] === 'data' && ['get', 'query'].includes(args[1]))
      )
    ).to.equal(true);
  });
  it('reports inaccessible, incomplete, ambiguous and missing association evidence without false absence', async () => {
    const s = { ...selection, operation: 'export' as const, artifact: undefined, expectedName: undefined };
    const schema = {
      name: 'Campaign',
      queryable: true,
      fields: [{ name: 'Id', type: 'id' }],
      childRelationships: [{ relationshipName: 'Flows', childSObject: 'FlowRecord', field: 'AssociatedRecordId' }],
    };
    const flowSchema = (name: string, names: string[]): unknown => ({
      name,
      queryable: true,
      fields: names.map((field) => ({ name: field, type: 'string' })),
    });
    const coreSchema = flowSchema('FlowRecord', ['Id', 'ApiName', 'AssociatedRecordId', 'SegmentId']);
    for (const bad of [
      { done: false, totalSize: 0, records: [] },
      { done: true, totalSize: 1, records: [] },
      rows([{ Id: '2aF000000000001AAA', AssociatedRecordId: sourceId }]),
      rows(Array.from({ length: 101 }, () => ({}))),
    ]) {
      // eslint-disable-next-line no-await-in-loop -- Sequential fixture transports keep each failure case isolated.
      const exported = await runCampaign(s, transport([rows([{ Id: org }]), schema, { Id: id }, coreSchema, bad], []));
      if (exported.operation !== 'export') throw new Error('Expected export');
      expect(exported.diagnostics.associatedArtifacts.status).to.equal('blocked');
      expect(exported.diagnostics.associatedArtifacts.reason).to.match(/Incomplete|Ambiguous/);
    }
    for (const segment of [undefined, '', null]) {
      const flow = {
        Id: '2aF000000000001AAA',
        AssociatedRecordId: id,
        ApiName: 'Flow_1',
        ...(segment === undefined ? {} : { SegmentId: segment }),
      };
      // eslint-disable-next-line no-await-in-loop -- Sequential fixture transports keep each failure case isolated.
      const exported = await runCampaign(
        s,
        transport(
          [
            rows([{ Id: org }]),
            schema,
            { Id: id },
            coreSchema,
            rows([flow]),
            flowSchema('FlowDefinition', ['Id', 'DeveloperName', 'ActiveVersionId', 'LatestVersionId']),
            flowSchema('Flow', ['Id', 'DefinitionId', 'Metadata']),
            rows([]),
          ],
          []
        )
      );
      if (exported.operation !== 'export') throw new Error('Expected export');
      expect(exported.diagnostics.associatedArtifacts.status).to.equal('incomplete');
      expect(exported.diagnostics.associatedArtifacts.flows?.[0].record).to.deep.equal(flow);
      expect(exported.diagnostics.associatedArtifacts.flows?.[0].reason).to.include(
        segment === undefined ? 'missing is not null' : segment === '' ? 'empty or malformed' : 'absent or ambiguous'
      );
    }
    const denied = await runCampaign(s, transport([rows([{ Id: org }]), schema, { Id: id }, {}], []));
    if (denied.operation !== 'export') throw new Error('Expected export');
    expect(denied.diagnostics.associatedArtifacts.status).to.equal('blocked');
    expect(denied.diagnostics.associatedArtifacts.reason).to.include('schema');
  });
  it('blocks ambiguous Tooling members, core-version substitutions and incomplete version configuration', async () => {
    const s = { ...selection, operation: 'export' as const, artifact: undefined, expectedName: undefined };
    const schema = (name: string, names: string[]): unknown => ({
      name,
      queryable: true,
      fields: names.map((field) => ({ name: field, type: 'string' })),
    });
    const campaignSchema = {
      name: 'Campaign',
      queryable: true,
      fields: [{ name: 'Id', type: 'id' }],
      childRelationships: [{ relationshipName: 'Flows', childSObject: 'FlowRecord', field: 'AssociatedRecordId' }],
    };
    const flow = {
      Id: '2aF000000000001AAA',
      ApiName: 'Flow_1',
      AssociatedRecordId: id,
      SegmentId: null,
      ActiveVersionId: '10v000000000001AAA',
    };
    const definition = {
      Id: '300000000000001AAA',
      DeveloperName: 'Flow_1',
      ActiveVersionId: null,
      LatestVersionId: '301000000000001AAA',
    };
    const version = {
      Id: definition.LatestVersionId,
      DefinitionId: definition.Id,
      Metadata: { start: { triggerType: 'Segment', segment: 'Audience_1' } },
    };
    for (const evidence of [
      [rows([definition, definition])],
      [rows([{ ...definition, LatestVersionId: flow.ActiveVersionId }])],
      [rows([{ ...definition, LatestVersionId: null }])],
      [rows([definition]), { done: false, totalSize: 1, records: [version] }],
      [rows([definition]), rows([{ ...version, DefinitionId: '300000000000002AAA' }])],
      [rows([definition]), rows([{ ...version, Metadata: { start: { triggerType: 'Segment' } } }])],
    ]) {
      const calls: string[][] = [];
      // eslint-disable-next-line no-await-in-loop -- Sequential fixture transports keep each failure case isolated.
      const exported = await runCampaign(
        s,
        transport(
          [
            rows([{ Id: org }]),
            campaignSchema,
            { Id: id },
            schema('FlowRecord', Object.keys(flow)),
            rows([flow]),
            schema('FlowDefinition', Object.keys(definition)),
            schema('Flow', Object.keys(version)),
            ...evidence,
          ],
          calls
        )
      );
      if (exported.operation !== 'export') throw new Error('Expected export');
      expect(exported.diagnostics.associatedArtifacts.status).to.equal('incomplete');
      expect(exported.diagnostics.associatedArtifacts.flows?.[0].status).to.equal('blocked');
      expect(exported.diagnostics.associatedArtifacts.flows?.[0].record.SegmentId).to.equal(null);
      expect(
        calls.some((args) => args.includes('--query') && args[args.indexOf('--query') + 1].includes("WHERE Id = '10v"))
      ).to.equal(false);
    }
  });
  it('creates a distinct name, persists mapping before readback and refuses journal reuse', async () => {
    const run = await createRunOwnedTemp('campaign-test');
    const root = await createRunOwnedDirectory(run, 'project');
    const sentinel = join(run.root, 'sentinel.txt');
    await writeFile(sentinel, 'preserve sibling', { flag: 'wx' });
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
      await removeRunOwnedPath(run, root);
      expect(existsSync(root)).to.equal(false);
      expect((await lstat(run.root)).isDirectory()).to.equal(true);
      expect(await readFile(sentinel, 'utf8')).to.equal('preserve sibling');
      await unlink(sentinel);
      await removeRunOwnedRoot(run);
      expect(existsSync(run.root)).to.equal(false);
    }
  });
  it('requires a complete null relationship projection after CREATE', async () => {
    const run = await createRunOwnedTemp('campaign-create-relationships');
    const root = await createRunOwnedDirectory(run, 'project');
    const sentinel = join(run.root, 'sentinel.txt');
    await writeFile(sentinel, 'preserve sibling', { flag: 'wx' });
    try {
      const create: CampaignSelection = {
        ...selection,
        operation: 'create',
        projectRoot: root,
        recordId: undefined,
        expectedName: undefined,
        targetName: record.Name,
        artifact: { sourceId, fields: { Name: 'Source campaign', Description: 'Before' } },
        journalFile: 'identity.json',
      };
      await Promise.all(
        ['ParentId', 'RecordTypeId', 'BriefId', 'CampaignImageId', 'CampaignMemberRecordTypeId'].map(
          async (relationship) => {
            const related = { ...record, Description: 'Before', [relationship]: sourceId };
            await rejects(
              { ...create, journalFile: `${relationship}.json` },
              [rows([{ Id: org }]), description, rows([]), saved, related],
              'unsupported relationships'
            );
          }
        )
      );
      const missing: Record<string, unknown> = { ...record, Description: 'Before' };
      delete missing.ParentId;
      await rejects(
        { ...create, journalFile: 'missing.json' },
        [rows([{ Id: org }]), description, rows([]), saved, missing],
        'lacks required relationship projection'
      );
    } finally {
      await removeRunOwnedPath(run, root);
      expect(existsSync(root)).to.equal(false);
      expect((await lstat(run.root)).isDirectory()).to.equal(true);
      expect(await readFile(sentinel, 'utf8')).to.equal('preserve sibling');
      await unlink(sentinel);
      await removeRunOwnedRoot(run);
      expect(existsSync(run.root)).to.equal(false);
    }
  });
  it('validates journal paths before transport and accepts a nested project path', async () => {
    const run = await createRunOwnedTemp('campaign-journal-path');
    const root = await createRunOwnedDirectory(run, 'project');
    const sentinel = join(run.root, 'sentinel.txt');
    await writeFile(sentinel, 'preserve sibling', { flag: 'wx' });
    try {
      const create: CampaignSelection = {
        ...selection,
        operation: 'create',
        projectRoot: root,
        recordId: undefined,
        expectedName: undefined,
        targetName: record.Name,
        artifact: { sourceId, fields: { Name: 'Source campaign', Description: 'Before' } },
        journalFile: 'journals/nested/identity.json',
      };
      expect(
        await rejects({ ...create, journalFile: join(root, 'identity.json') }, [], 'relative project path')
      ).to.have.length(0);
      expect(await rejects({ ...create, journalFile: '../identity.json' }, [], 'traversal segments')).to.have.length(0);
      await mkdir(join(root, 'journals', 'nested'), { recursive: true });
      await runCampaign(
        create,
        transport([rows([{ Id: org }]), description, rows([]), saved, { ...record, Description: 'Before' }], [])
      );
      expect(JSON.parse(await readFile(join(root, 'journals', 'nested', 'identity.json'), 'utf8'))).to.include({
        state: 'created',
        targetId: id,
      });
    } finally {
      await removeRunOwnedPath(run, root);
      expect(existsSync(root)).to.equal(false);
      expect((await lstat(run.root)).isDirectory()).to.equal(true);
      expect(await readFile(sentinel, 'utf8')).to.equal('preserve sibling');
      await unlink(sentinel);
      await removeRunOwnedRoot(run);
      expect(existsSync(run.root)).to.equal(false);
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
  it('accepts only a repeated unchanged update whose independent baseline already matches', async () => {
    const unchanged = { ...selection, expectUnchanged: true };
    const calls: string[][] = [];
    await runCampaign(
      unchanged,
      transport(
        [
          rows([{ Id: org }]),
          description,
          { ...record, Description: 'After' },
          saved,
          { ...record, Description: 'After' },
        ],
        calls
      )
    );
    expect(calls[3]).to.include("Description='After'");
    expect(
      await rejects(unchanged, [rows([{ Id: org }]), description, record], 'differs from the independent baseline')
    ).to.have.length(3);
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
  it('rejects absent relationship, owner and scalar preservation fields before and after mutation', async () => {
    await Promise.all(
      ['ParentId', 'OwnerId', 'StartDate'].map(async (field) => {
        const incompleteBaseline = { ...record };
        delete incompleteBaseline[field as keyof typeof incompleteBaseline];
        expect(
          await rejects(selection, [rows([{ Id: org }]), description, incompleteBaseline], 'baseline lacks')
        ).to.have.length(3);

        const incompleteAfter = { ...record, Description: 'After' };
        delete incompleteAfter[field as keyof typeof incompleteAfter];
        const calls = await rejects(
          selection,
          [rows([{ Id: org }]), description, record, saved, incompleteAfter],
          'readback lacks'
        );
        expect(calls).to.have.length(5);
      })
    );
  });
});
