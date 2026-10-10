import { existsSync, watch, writeFileSync } from 'node:fs';
import filesystem, { lstat, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect } from 'chai';
import sinon from 'sinon';
import { retrieveCampaignFlows } from '../../src/core/campaignFlowRetrieval.js';
import { type CoreRunner } from '../../src/core/flowCli.js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
  type RunOwnedTemp,
} from '../../src/filesystem/runOwnedTemp.js';

const campaignId = '701000000000001AAA';
const org = '00D000000000001AAA';
const content = 'marketing--Example_Workspace.sfdc_cms__email--EXAMPLE_CONTENT_KEY';
const secondContent = 'marketing--Example_Workspace.sfdc_cms__email--SECOND_CONTENT_KEY';
const segment = '1sg000000000001AAA';
const schema = (name: string, fields: string[]): unknown => ({
  name,
  queryable: true,
  fields: fields.map((field) => ({ name: field, type: 'string' })),
});
const rows = (records: unknown[]): unknown => ({ done: true, totalSize: records.length, records });
const id = (prefix: string, index: number): string => `${prefix}${String(index).padStart(12, '0')}AAA`;
const record = (index: number): Record<string, unknown> => ({
  Id: id('2aF', index),
  ApiName: `Example_${index}`,
  AssociatedRecordId: campaignId,
  SegmentId: segment,
});
const definition = (index: number): Record<string, unknown> => ({
  Id: id('300', index),
  DeveloperName: `Example_${index}`,
  LatestVersionId: id('301', index),
  ActiveVersionId: null,
});
const version = (index: number): Record<string, unknown> => ({
  Id: id('301', index),
  DefinitionId: id('300', index),
  Metadata: {
    start: { triggerType: 'Segment', segment },
    actionCalls: [content, secondContent].map((stringValue) => ({
      inputParameters: [{ name: 'contentId', value: { stringValue } }],
    })),
  },
});
type Options = {
  records?: Array<Record<string, unknown>>;
  definition?: Record<string, unknown>;
  version?: Record<string, unknown>;
  incomplete?: boolean;
  org?: string;
  xml?: string;
  native?: (cwd: string, files: Array<Record<string, unknown>>) => Promise<Record<string, unknown>>;
};

describe('Campaign associated native Flow provider', () => {
  let run: RunOwnedTemp;
  let project: string;
  let xml: string;
  const retained: string[] = [];
  const calls: Array<{ args: string[]; cwd: string }> = [];
  beforeEach(async () => {
    run = await createRunOwnedTemp('campaign-flow-test');
    project = await createRunOwnedDirectory(run, 'project');
    await mkdir(join(project, 'packages', 'native'), { recursive: true });
    await mkdir(join(project, 'other'));
    await writeFile(
      join(project, 'sfdx-project.json'),
      JSON.stringify({
        packageDirectories: [{ path: 'packages/native', default: true }, { path: 'other' }],
        sourceApiVersion: '66.0',
      })
    );
    xml = await readFile(join('test', 'core', 'fixtures', 'segment-email.flow-meta.xml'), 'utf8');
    const action = xml.slice(
      xml.indexOf('    <actionCalls>'),
      xml.indexOf('    </actionCalls>') + '    </actionCalls>'.length
    );
    xml = xml.replace(
      '    <apiVersion>',
      `${action
        .replaceAll(content, secondContent)
        .replaceAll('Send_Email_Message_Action', 'Second_Email_Action')}\n    <apiVersion>`
    );
    calls.length = 0;
  });
  afterEach(async () => {
    sinon.restore();
    // Provider failure staging belongs to its own run, not this fixture. Retain it for evidence.
    await removeRunOwnedPath(run, project);
    await removeRunOwnedRoot(run);
  });
  function transport(options: Options = {}): CoreRunner {
    const records = options.records ?? [record(1)];
    return async (args, cwd) => {
      calls.push({ args, cwd });
      let value: unknown;
      if (args[0] === 'project') {
        const staged: unknown = JSON.parse(await readFile(join(cwd, 'sfdx-project.json'), 'utf8'));
        expect(staged).to.deep.equal({
          packageDirectories: [{ path: 'packages/native', default: true }, { path: 'other' }],
          sourceApiVersion: '67.0',
        });
        const files = await Promise.all(
          records.map(async (entry, index) => {
            const folder = join(cwd, index === 0 ? 'packages/native' : 'other', 'main', 'default', 'flows');
            await mkdir(folder, { recursive: true });
            const filePath = join(folder, `${String(entry.ApiName)}.flow-meta.xml`);
            await writeFile(filePath, options.xml ?? xml);
            return { type: 'Flow', fullName: entry.ApiName, filePath, state: 'Created' };
          })
        );
        value = options.native
          ? await options.native(cwd, files)
          : { files, id: 'job', done: true, success: true, status: 'Succeeded' };
      } else if (args[0] === 'sobject') {
        const name = args[args.indexOf('--sobject') + 1];
        value =
          name === 'Campaign'
            ? {
                ...(schema(name, ['Id']) as object),
                childRelationships: [
                  { relationshipName: 'Flows', childSObject: 'FlowRecord', field: 'AssociatedRecordId' },
                ],
              }
            : schema(
                name,
                name === 'FlowRecord'
                  ? ['Id', 'ApiName', 'AssociatedRecordId', 'SegmentId']
                  : name === 'FlowDefinition'
                  ? ['Id', 'DeveloperName', 'LatestVersionId', 'ActiveVersionId']
                  : ['Id', 'DefinitionId', 'Metadata']
              );
      } else if (args[1] === 'get') value = { Id: campaignId };
      else {
        const query = args[args.indexOf('--query') + 1];
        if (query.includes('FROM Organization')) value = rows([{ Id: options.org ?? org }]);
        else if (query.includes('FROM FlowRecord'))
          value = options.incomplete ? { done: false, totalSize: records.length + 1, records } : rows(records);
        else if (query.includes('FROM FlowDefinition')) {
          const index = Number(query.match(/Example_(\d+)/)?.[1]);
          value = rows([options.definition ?? definition(index)]);
        } else {
          const index = Number(query.match(/301(\d{12})AAA/)?.[1]);
          value = rows([options.version ?? version(index)]);
        }
      }
      return { stdout: JSON.stringify({ status: 0, result: value }), exitCode: 0 };
    };
  }
  async function retrieve(options: Options = {}): Promise<Awaited<ReturnType<typeof retrieveCampaignFlows>>> {
    const actual = await retrieveCampaignFlows(
      { projectRoot: project, targetOrg: 'source', expectedOrgId: org, apiVersion: '67.0', campaignId, waitMinutes: 1 },
      transport(options)
    );
    if (actual.stagingProject) retained.push(actual.stagingProject);
    return actual;
  }
  it('retrieves all exact members into mirrored roots and preserves native Segment/two CMS references byte-for-byte', async () => {
    const actual = await retrieve({ records: [record(1), record(2)] });
    expect(actual.state).to.equal('succeeded');
    expect(actual.members).to.deep.equal(['Example_1', 'Example_2']);
    expect(actual.associationPersistence).to.equal('blocked');
    expect(actual.stagingProject).to.equal(undefined);
    expect(actual.files.map((file) => file.filePath)).to.deep.equal([
      join(project, 'packages/native/main/default/flows/Example_1.flow-meta.xml'),
      join(project, 'other/main/default/flows/Example_2.flow-meta.xml'),
    ]);
    await Promise.all(actual.files.map(async (file) => expect(await readFile(file.filePath, 'utf8')).to.equal(xml)));
    const native = calls.find((call) => call.args[0] === 'project')!;
    expect(existsSync(native.cwd)).to.equal(false);
    expect(native.args).to.deep.equal([
      'project',
      'retrieve',
      'start',
      '--target-org',
      'source',
      '--metadata',
      'Flow:Example_1',
      '--metadata',
      'Flow:Example_2',
      '--api-version',
      '67.0',
      '--wait',
      '1',
      '--json',
    ]);
    expect(
      calls.every(
        (call) => !call.args.includes('deploy') && !call.args.includes('update') && !call.args.includes('create')
      )
    ).to.equal(true);
    expect(
      calls
        .filter((call) => call.args[0] !== 'project')
        .every((call) => call.args.includes('67.0') && call.args.includes('source'))
    ).to.equal(true);
    expect(
      calls.some((call) =>
        call.args.some((arg) => arg.includes('SELECT Id, ApiName, AssociatedRecordId, SegmentId, LatestVersionId'))
      )
    ).to.equal(false);
  });
  for (const boundary of ['stage', 'root'] as const)
    it(`preserves closed Flow files and truthful locators after ${boundary} cleanup refusal`, async () => {
      let stage = '';
      let sentinel = '';
      const original = filesystem.open;
      sinon.stub(filesystem, 'open').callsFake(async (...args: Parameters<typeof filesystem.open>) => {
        const handle = await original(...args);
        if (String(args[0]).endsWith('Example_1.flow-meta.xml') && args[1] === 'wx') {
          const close = handle.close.bind(handle);
          sinon.stub(handle, 'close').callsFake(async () => {
            await close();
            sentinel = join(
              dirname(stage),
              boundary === 'root' ? 'unregistered-user-file' : '.sf-mcnext-run-owner.json'
            );
            await writeFile(sentinel, 'do not delete');
          });
        }
        return handle;
      });
      const actual = await retrieve({
        native: async (cwd, files) => {
          stage = cwd;
          return { files, id: 'job', done: true, success: true, status: 'Succeeded' };
        },
      });
      expect(actual.state).to.equal('succeeded');
      expect(actual.files).to.have.length(1);
      expect(await readFile(actual.files[0].filePath, 'utf8')).to.equal(xml);
      expect(actual.diagnostics.join('\n')).to.include('Native Flow cleanup warning');
      expect(existsSync(stage)).to.equal(boundary === 'stage');
      expect(actual.stagingProject).to.equal(boundary === 'stage' ? stage : undefined);
      expect(actual.retainedRoot).to.equal(boundary === 'root' ? dirname(stage) : undefined);
      expect((await lstat(actual.stagingProject ?? actual.retainedRoot!)).isDirectory()).to.equal(true);
      expect(await readFile(sentinel, 'utf8')).to.equal('do not delete');
      for (const forbidden of ['stagingOwner', 'token', '"type":"Buffer"'])
        expect(JSON.stringify(actual)).not.to.include(forbidden);
    });
  it('re-resolves latest Tooling identity without requiring FullName or core LatestVersionId', async () => {
    const actual = await retrieve({
      definition: { ...definition(1), LatestVersionId: id('301', 9) },
      version: { ...version(9), DefinitionId: id('300', 1) },
    });
    expect(actual.state).to.equal('succeeded');
    expect(calls.some((call) => call.args.some((arg) => arg.includes(`WHERE Id = '${id('301', 9)}'`)))).to.equal(true);
    expect(actual.files).to.have.length(1);
  });
  it('retains failed staging and known job evidence for malformed success envelopes', async () => {
    const actual = await retrieve({
      native: async () => ({ id: 'known-job', status: 'Succeeded', done: true, success: false }),
    });
    expect(actual.state).to.equal('failed');
    expect(actual.jobId).to.equal('known-job');
    expect(actual.files).to.deep.equal([]);
    expect(existsSync(actual.stagingProject!)).to.equal(true);
  });
  it('returns complete empty discovery without native calls or staging', async () => {
    const actual = await retrieve({ records: [] });
    expect(actual).to.include({ state: 'succeeded', associationPersistence: 'blocked' });
    expect(actual.files).to.deep.equal([]);
    expect(calls.some((call) => call.args[0] === 'project')).to.equal(false);
  });
  it('blocks wrong org, incomplete, duplicate, mismatched and malformed discovery before native calls', async () => {
    for (const options of [
      { org: '00D000000000002AAA' },
      { incomplete: true },
      { records: [record(1), record(1)] },
      { records: [record(1), { ...record(2), ApiName: 'Example_1' }] },
      { records: [{ ...record(1), AssociatedRecordId: '701000000000002AAA' }] },
      { records: [{ ...record(1), SegmentId: undefined }] },
      { definition: { ...definition(1), LatestVersionId: '10v000000000001AAA' } },
      { version: { ...version(1), DefinitionId: id('300', 2) } },
      { version: { ...version(1), Metadata: null } },
    ]) {
      calls.length = 0;
      // eslint-disable-next-line no-await-in-loop -- cases share a fixture and must run serially
      const actual = await retrieve(options);
      expect(actual.state).to.equal('blocked');
      expect(actual.files).to.deep.equal([]);
      expect(calls.some((call) => call.args[0] === 'project')).to.equal(false);
    }
  });
  it('retains pending and failed native job staging and diagnostics without publication', async () => {
    for (const status of ['Pending', 'Failed']) {
      // eslint-disable-next-line no-await-in-loop -- cases share a fixture and must run serially
      const actual = await retrieve({
        native: async () => ({
          id: 'job-evidence',
          status,
          done: status !== 'Pending',
          success: false,
          details: { componentFailures: [{ problem: 'reason' }] },
        }),
      });
      expect(actual.state).to.equal(status === 'Pending' ? 'pending' : 'failed');
      expect(actual.jobId).to.equal('job-evidence');
      expect(actual.files).to.deep.equal([]);
      expect(existsSync(actual.stagingProject!)).to.equal(true);
    }
  });
  it('rejects extra, duplicate, wrong member/location, outside and missing authoritative native paths', async () => {
    for (const transform of [
      (files: Array<Record<string, unknown>>) => [...files, files[0]],
      (files: Array<Record<string, unknown>>) => [{ ...files[0], fullName: 'Other' }],
      (files: Array<Record<string, unknown>>) => [{ ...files[0], filePath: join(project, 'outside.xml') }],
      (files: Array<Record<string, unknown>>) => [
        { ...files[0], filePath: join(String(files[0].filePath), '..', 'Other.flow-meta.xml') },
      ],
      () => [],
    ]) {
      // eslint-disable-next-line no-await-in-loop -- cases share a fixture and must run serially
      const actual = await retrieve({
        native: async (_cwd, files) => ({
          id: 'job',
          status: 'Succeeded',
          done: true,
          success: true,
          files: transform(files),
        }),
      });
      expect(actual.state).to.equal('failed');
      expect(actual.files).to.deep.equal([]);
      expect(existsSync(actual.stagingProject!)).to.equal(true);
    }
  });
  it('validates every XML before publishing and never invents missing Segment/CMS references', async () => {
    for (const invalid of [
      '<Flow>',
      '<Other/>',
      xml.replace(segment, '1sg000000000002AAA'),
      xml.replace(secondContent, 'wrong'),
    ]) {
      // eslint-disable-next-line no-await-in-loop -- cases share a fixture and must run serially
      const actual = await retrieve({ xml: invalid, records: [record(1), record(2)] });
      expect(actual.state).to.equal('failed');
      expect(actual.files).to.deep.equal([]);
      expect(existsSync(join(project, 'packages/native/main/default/flows/Example_1.flow-meta.xml'))).to.equal(false);
    }
  });
  it('preflights all destinations and preserves an existing second-member sentinel', async () => {
    const folder = join(project, 'other/main/default/flows');
    await mkdir(folder, { recursive: true });
    const sentinel = join(folder, 'Example_2.flow-meta.xml');
    await writeFile(sentinel, 'sentinel');
    const actual = await retrieve({ records: [record(1), record(2)] });
    expect(actual.state).to.equal('failed');
    expect(actual.files).to.deep.equal([]);
    expect(await readFile(sentinel, 'utf8')).to.equal('sentinel');
    expect(existsSync(join(project, 'packages/native/main/default/flows/Example_1.flow-meta.xml'))).to.equal(false);
  });
  it('keeps actual published files and retained staging when a racing second destination appears', async () => {
    const firstFolder = join(project, 'packages/native/main/default/flows');
    const secondFolder = join(project, 'other/main/default/flows');
    await mkdir(firstFolder, { recursive: true });
    await mkdir(secondFolder, { recursive: true });
    const sentinel = join(secondFolder, 'Example_2.flow-meta.xml');
    const watcher = watch(firstFolder, (_event, name) => {
      if (String(name) === 'Example_1.flow-meta.xml' && !existsSync(sentinel))
        writeFileSync(sentinel, 'racing sentinel', { flag: 'wx' });
    });
    try {
      const actual = await retrieve({ records: [record(1), record(2)] });
      expect(actual.state).to.equal('failed');
      expect(actual.files).to.deep.equal([
        { member: 'Example_1', filePath: join(firstFolder, 'Example_1.flow-meta.xml') },
      ]);
      expect(await readFile(actual.files[0].filePath, 'utf8')).to.equal(xml);
      expect(await readFile(sentinel, 'utf8')).to.equal('racing sentinel');
      expect(existsSync(actual.stagingProject!)).to.equal(true);
    } finally {
      watcher.close();
    }
  });
  for (const failure of ['writeFile', 'close'] as const)
    for (const failedMember of [1, 2])
      it(`claims only earlier closed files after ${failure} failure on member ${failedMember}`, async () => {
        const attempted = join(
          project,
          failedMember === 1 ? 'packages/native' : 'other',
          'main/default/flows',
          `Example_${failedMember}.flow-meta.xml`
        );
        const sentinel = join(project, 'sentinel.txt');
        await writeFile(sentinel, 'existing sentinel');
        const original = filesystem.open;
        let closed = false;
        sinon.stub(filesystem, 'open').callsFake(async (...args: Parameters<typeof filesystem.open>) => {
          const handle = await original(...args);
          if (String(args[0]) === attempted && args[1] === 'wx') {
            const close = handle.close.bind(handle);
            sinon.stub(handle, 'close').callsFake(async () => {
              await close();
              closed = true;
              if (failure === 'close') throw new Error('injected close failure');
            });
            if (failure === 'writeFile') {
              const write = handle.writeFile.bind(handle);
              sinon.stub(handle, 'writeFile').callsFake(async () => {
                await write('partial native bytes');
                throw new Error('injected write failure');
              });
            }
          }
          return handle;
        });
        const actual = await retrieve({ records: [record(1), record(2)] });
        expect(actual.state).to.equal('failed');
        expect(actual.jobId).to.equal('job');
        expect(closed).to.equal(true);
        expect(actual.files).to.deep.equal(
          failedMember === 1
            ? []
            : [
                {
                  member: 'Example_1',
                  filePath: join(project, 'packages/native/main/default/flows/Example_1.flow-meta.xml'),
                },
              ]
        );
        await Promise.all(
          actual.files.map(async (file) => expect(await readFile(file.filePath, 'utf8')).to.equal(xml))
        );
        expect(await readFile(attempted, 'utf8')).to.equal(failure === 'writeFile' ? 'partial native bytes' : xml);
        expect(actual.diagnostics.join('\n'))
          .to.include(attempted)
          .and.include(`injected ${failure === 'writeFile' ? 'write' : 'close'} failure`);
        expect(await readFile(sentinel, 'utf8')).to.equal('existing sentinel');
        expect(existsSync(actual.stagingProject!)).to.equal(true);
        expect(
          await readFile(
            join(
              actual.stagingProject!,
              failedMember === 1 ? 'packages/native' : 'other',
              'main/default/flows',
              `Example_${failedMember}.flow-meta.xml`
            ),
            'utf8'
          )
        ).to.equal(xml);
        if (failedMember === 1)
          expect(existsSync(join(project, 'other/main/default/flows/Example_2.flow-meta.xml'))).to.equal(false);
      });
  it('rejects unsafe/overlapping package roots before native retrieval', async () => {
    for (const packageDirectories of [
      [{ path: '../outside', default: true }],
      [{ path: 'C:/outside', default: true }],
      [{ path: 'packages', default: true }, { path: 'packages/native' }],
    ]) {
      calls.length = 0;
      // eslint-disable-next-line no-await-in-loop -- each case changes the same fixture configuration
      await writeFile(join(project, 'sfdx-project.json'), JSON.stringify({ packageDirectories }));
      // eslint-disable-next-line no-await-in-loop -- verify each configuration before replacing it
      expect((await retrieve()).state).to.equal('blocked');
      expect(calls.some((call) => call.args[0] === 'project')).to.equal(false);
    }
  });
  (process.platform === 'win32' ? it : it.skip)(
    'rejects case-only aliases of the default package root before native retrieval on Windows',
    async () => {
      await writeFile(
        join(project, 'sfdx-project.json'),
        JSON.stringify({
          packageDirectories: [{ path: 'packages/native', default: true }, { path: 'Packages/Native' }],
        })
      );
      const actual = await retrieve();
      expect(actual.state).to.equal('blocked');
      expect(actual.files).to.deep.equal([]);
      expect(actual.stagingProject).to.equal(undefined);
      expect(actual.diagnostics.join('\n')).to.include('Duplicate or overlapping package roots');
      expect(calls.some((call) => call.args[0] === 'project')).to.equal(false);
    }
  );
  it('rejects a junction ancestor for destination IO independently of cleanup', async () => {
    const external = await createRunOwnedDirectory(run, 'external');
    const link = join(project, 'linked');
    await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await writeFile(
        join(project, 'sfdx-project.json'),
        JSON.stringify({ packageDirectories: [{ path: 'linked', default: true }] })
      );
      // eslint-disable-next-line no-await-in-loop -- cases share a fixture and must run serially
      const actual = await retrieve();
      expect(actual.state).to.equal('blocked');
      expect(calls.some((call) => call.args[0] === 'project')).to.equal(false);
      expect(await lstat(link)).to.have.property('isSymbolicLink');
    } finally {
      await unlink(link);
      await removeRunOwnedPath(run, external);
    }
  });
  it('rejects native source reparse points before reading/publication and retains evidence', async () => {
    let link = '';
    try {
      // eslint-disable-next-line no-await-in-loop -- cases share a fixture and must run serially
      const actual = await retrieve({
        native: async (cwd, files) => {
          const source = String(files[0].filePath);
          const external = join(cwd, 'external.xml');
          await writeFile(external, xml);
          await unlink(source);
          link = source;
          await symlink(external, source, 'file');
          return { files, id: 'job', done: true, success: true, status: 'Succeeded' };
        },
      });
      expect(actual.state).to.equal('failed');
      expect(actual.files).to.deep.equal([]);
    } finally {
      if (link && existsSync(link)) await unlink(link);
    }
  });
});
