import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect } from 'chai';
import { flowPaths, sidecarPathOf } from '../../src/flow/file.js';
import { removeFlows } from '../../src/flow/remove.js';
import { fakeConnection, FLOW_FILE, flowRecord, refusal, removeTempFolders, tempFolder } from './support.js';

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

async function project(...apiNames: string[]): Promise<string> {
  const root = await tempFolder();
  for (const apiName of apiNames) {
    const paths = flowPaths(root, apiName);
    // eslint-disable-next-line no-await-in-loop -- a handful of files
    await mkdir(dirname(paths.xml), { recursive: true });
    // eslint-disable-next-line no-await-in-loop -- a handful of files
    await writeFile(paths.xml, FLOW_FILE, 'utf8');
    // eslint-disable-next-line no-await-in-loop -- a handful of files
    await writeFile(paths.sidecar, '{"needs":[]}\n', 'utf8');
  }
  return root;
}

describe('removeFlows', () => {
  afterEach(removeTempFolders);

  it('deletes the FlowRecord row and the local files', async () => {
    const projectDir = await project('WelcomeFlow', 'OtherFlow');
    const fake = fakeConnection({ flowRecords: [flowRecord('WelcomeFlow'), flowRecord('OtherFlow')] });
    const id = fake.org.flowRecords[0].Id as string;
    const items = await removeFlows(fake.connection, {
      flows: [{ name: 'WelcomeFlow' }],
      preview: false,
      projectDir,
      keepLocalFiles: false,
    });
    expect(items).to.have.length(1);
    expect(items[0]).to.include({ area: 'mcnext', type: 'flow', name: 'WelcomeFlow', outcome: 'deleted', id });
    expect(fake.writes).to.deep.equal([
      { method: 'DELETE', url: `/services/data/v68.0/sobjects/FlowRecord/${id}`, body: undefined },
    ]);
    const paths = flowPaths(projectDir, 'WelcomeFlow');
    expect(await exists(paths.xml)).to.equal(false);
    expect(await exists(paths.sidecar)).to.equal(false);
    expect(await exists(flowPaths(projectDir, 'OtherFlow').xml)).to.equal(true);
  });

  it('keeps the local files when asked', async () => {
    const projectDir = await project('WelcomeFlow');
    const fake = fakeConnection({ flowRecords: [flowRecord('WelcomeFlow')] });
    const items = await removeFlows(fake.connection, {
      flows: [{ name: 'WelcomeFlow' }],
      preview: false,
      projectDir,
      keepLocalFiles: true,
    });
    expect(items[0].outcome).to.equal('deleted');
    expect(await exists(flowPaths(projectDir, 'WelcomeFlow').xml)).to.equal(true);
  });

  it('blocks a flow with an active version and keeps its files', async () => {
    const projectDir = await project('WelcomeFlow');
    const fake = fakeConnection({
      flowRecords: [flowRecord('WelcomeFlow', { ActiveVersionId: '2aG000000000001AAA' })],
    });
    for (const preview of [true, false]) {
      // eslint-disable-next-line no-await-in-loop -- two runs
      const items = await removeFlows(fake.connection, {
        flows: [{ name: 'WelcomeFlow' }],
        preview,
        projectDir,
        keepLocalFiles: false,
      });
      expect(items[0]).to.include({ outcome: 'blocked', code: 'FLOW_ACTIVE' });
    }
    expect(fake.writes).to.have.length(0);
    expect(await exists(flowPaths(projectDir, 'WelcomeFlow').xml)).to.equal(true);
  });

  it('reports a flow the org does not have as unchanged and keeps its files', async () => {
    const projectDir = await project('GoneFlow');
    const fake = fakeConnection({ flowRecords: [] });
    const items = await removeFlows(fake.connection, {
      flows: [{ name: 'GoneFlow' }],
      preview: false,
      projectDir,
      keepLocalFiles: false,
    });
    expect(items[0].outcome).to.equal('unchanged');
    expect(fake.writes).to.have.length(0);
    expect(await exists(flowPaths(projectDir, 'GoneFlow').xml)).to.equal(true);
    expect(await exists(flowPaths(projectDir, 'GoneFlow').sidecar)).to.equal(true);
  });

  it('removes the file the flow was selected from, not a file of the same name elsewhere', async () => {
    const projectDir = await project('WelcomeFlow');
    const own = flowPaths(projectDir, 'WelcomeFlow');
    const selected = join(projectDir, 'elsewhere', 'WelcomeFlow.flow-meta.xml');
    await mkdir(dirname(selected), { recursive: true });
    await writeFile(selected, FLOW_FILE, 'utf8');
    await writeFile(sidecarPathOf(selected), '{"needs":[]}\n', 'utf8');
    const fake = fakeConnection({ flowRecords: [flowRecord('WelcomeFlow')] });
    const items = await removeFlows(fake.connection, {
      flows: [{ name: 'WelcomeFlow', path: selected }],
      preview: false,
      projectDir,
      keepLocalFiles: false,
    });
    expect(items[0]).to.include({ outcome: 'deleted', path: selected });
    expect(await exists(selected)).to.equal(false);
    expect(await exists(sidecarPathOf(selected))).to.equal(false);
    expect(await exists(own.xml)).to.equal(true);
    expect(await exists(own.sidecar)).to.equal(true);
  });

  it('stops at the first flow with a problem and reports the rest as not-attempted', async () => {
    const projectDir = await project('FirstFlow', 'ActiveFlow', 'LastFlow');
    const org = {
      flowRecords: [
        flowRecord('FirstFlow'),
        flowRecord('ActiveFlow', { ActiveVersionId: '2aG000000000001AAA' }),
        flowRecord('LastFlow'),
      ],
    };
    const flows = [{ name: 'FirstFlow' }, { name: 'ActiveFlow' }, { name: 'LastFlow' }];
    const fake = fakeConnection(org);
    // A preview checks every flow.
    const preview = await removeFlows(fake.connection, { flows, preview: true, projectDir, keepLocalFiles: false });
    expect(preview.map((item) => item.outcome)).to.deep.equal(['would-delete', 'blocked', 'would-delete']);
    const items = await removeFlows(fake.connection, { flows, preview: false, projectDir, keepLocalFiles: false });
    expect(items.map((item) => [item.name, item.outcome])).to.deep.equal([
      ['FirstFlow', 'deleted'],
      ['ActiveFlow', 'blocked'],
      ['LastFlow', 'not-attempted'],
    ]);
    expect(fake.writes).to.have.length(1);
    expect(await exists(flowPaths(projectDir, 'FirstFlow').xml)).to.equal(false);
    expect(await exists(flowPaths(projectDir, 'LastFlow').xml)).to.equal(true);

    const failing = fakeConnection({
      flowRecords: [flowRecord('ActiveFlow'), flowRecord('LastFlow')],
      onWrite: () => {
        throw new Error('ETIMEDOUT');
      },
    });
    const unknown = await removeFlows(failing.connection, {
      flows: flows.slice(1),
      preview: false,
      projectDir,
      keepLocalFiles: false,
    });
    expect(unknown.map((item) => item.outcome)).to.deep.equal(['unknown', 'not-attempted']);
    expect(failing.writes).to.have.length(1);
  });

  it('previews without a write or a removed file', async () => {
    const projectDir = await project('WelcomeFlow');
    const fake = fakeConnection({ flowRecords: [flowRecord('WelcomeFlow')] });
    const items = await removeFlows(fake.connection, {
      flows: [{ name: 'WelcomeFlow' }, { name: 'GoneFlow' }],
      preview: true,
      projectDir,
      keepLocalFiles: false,
    });
    expect(items.map((item) => [item.name, item.outcome])).to.deep.equal([
      ['WelcomeFlow', 'would-delete'],
      ['GoneFlow', 'unchanged'],
    ]);
    expect(fake.writes).to.have.length(0);
    expect(await exists(flowPaths(projectDir, 'WelcomeFlow').xml)).to.equal(true);
  });

  it('tells a refused delete from one without an answer and keeps the files', async () => {
    const projectDir = await project('WelcomeFlow');
    const refused = fakeConnection({
      flowRecords: [flowRecord('WelcomeFlow')],
      onWrite: () => {
        throw refusal('cannot delete');
      },
    });
    const lost = fakeConnection({
      flowRecords: [flowRecord('WelcomeFlow')],
      onWrite: () => {
        throw new Error('ETIMEDOUT');
      },
    });
    const run = { flows: [{ name: 'WelcomeFlow' }], preview: false, projectDir, keepLocalFiles: false };
    expect((await removeFlows(refused.connection, run))[0]).to.include({
      outcome: 'failed',
      code: 'FLOW_DELETE_FAILED',
    });
    expect((await removeFlows(lost.connection, run))[0]).to.include({
      outcome: 'unknown',
      code: 'FLOW_DELETE_UNKNOWN',
    });
    expect(lost.writes).to.have.length(1);
    expect(await exists(flowPaths(projectDir, 'WelcomeFlow').xml)).to.equal(true);
  });

  it('returns failed items when the flows cannot be read', async () => {
    const fake = fakeConnection({ flowRecords: [], failQuery: 'FROM FlowRecord' });
    const items = await removeFlows(fake.connection, {
      flows: [{ name: 'A' }, { name: 'B' }],
      preview: false,
      projectDir: 'unused',
      keepLocalFiles: true,
    });
    expect(items.map((item) => [item.outcome, item.code])).to.deep.equal([
      ['failed', 'FLOW_READ_FAILED'],
      ['failed', 'FLOW_READ_FAILED'],
    ]);
  });
});
