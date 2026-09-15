import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { buildFlowArgs, parseFlowResult, runFlow, type FlowSelection } from '../../src/core/flowCli.js';

const selection: FlowSelection = {
  projectRoot: '.',
  targetOrg: 'target',
  members: ['mvpflowTest'],
  operation: 'retrieve',
};
const success = {
  id: 'job',
  status: 'Succeeded',
  done: true,
  success: true,
  files: [
    {
      type: 'Flow',
      fullName: 'mvpflowTest',
      state: 'Created',
      filePath: 'custom/main/default/flows/mvpflowTest.flow-meta.xml',
    },
  ],
};
const response = (result: unknown, exitCode = 0): { stdout: string; exitCode: number } => ({
  stdout: JSON.stringify({ status: exitCode, result }),
  exitCode,
});

describe('Core Flow selection boundary', () => {
  it('uses exact members and always dry-runs deployment without overriding source directories', () => {
    expect(buildFlowArgs(selection)).to.deep.equal([
      'project',
      'retrieve',
      'start',
      '--target-org',
      'target',
      '--metadata',
      'Flow:mvpflowTest',
      '--wait',
      '10',
      '--json',
    ]);
    expect(buildFlowArgs({ ...selection, operation: 'validate' }))
      .to.include('--dry-run')
      .and.include('deploy');
    for (const member of ['*', 'Flow:A', '../A', '--all', 'A B', 'A*']) {
      expect(() => buildFlowArgs({ ...selection, members: [member] })).to.throw('exact Flow');
    }
    expect(() => buildFlowArgs({ ...selection, members: [] })).to.throw();
    expect(() => buildFlowArgs({ ...selection, members: ['A', 'A'] })).to.throw('Duplicate');
    expect(() => buildFlowArgs({ ...selection, targetOrg: '' })).to.throw();
    expect(() => buildFlowArgs({ ...selection, waitMinutes: 0 })).to.throw();
    expect(() => buildFlowArgs({ ...selection, operation: 'deploy' as 'retrieve' })).to.throw('Unsupported');
  });

  it('requires completed successful jobs and selected artifact paths', () => {
    expect(parseFlowResult(selection, response(success))).to.include({ state: 'succeeded', jobId: 'job' });
    for (const status of ['Failed', 'Canceled', 'SucceededPartial', 'Nothing to deploy']) {
      expect(() => parseFlowResult(selection, response({ ...success, status }))).to.throw();
    }
    for (const patch of [
      { done: false },
      { success: false },
      { id: '' },
      { files: [] },
      { files: [{ ...success.files[0], state: 'Failed' }] },
    ]) {
      expect(() => parseFlowResult(selection, response({ ...success, ...patch }))).to.throw();
    }
    expect(() => parseFlowResult(selection, { stdout: '{}', exitCode: 0 })).to.throw();
    expect(() => parseFlowResult(selection, { stdout: '{bad', exitCode: 0 })).to.throw();
    expect(() => parseFlowResult(selection, { ...response(success), exitCode: 1 })).to.throw();
  });

  it('retains successful Info prerequisites and failed member diagnostics', () => {
    const info = { fullName: 'mvpflowTest', problemType: 'Info', problem: 'Select a From address', success: true };
    const result = { ...success, checkOnly: true, details: { componentSuccesses: [info] } };
    expect(parseFlowResult({ ...selection, operation: 'validate' }, response(result))).to.include({
      runtimeReadiness: 'not-assessed',
    });
    expect(parseFlowResult({ ...selection, operation: 'validate' }, response(result)).diagnostics).to.deep.equal([
      info,
    ]);
    expect(() =>
      parseFlowResult({ ...selection, operation: 'validate' }, response({ ...result, checkOnly: false }))
    ).to.throw('check-only');
    expect(() =>
      parseFlowResult(
        selection,
        response(
          { ...result, status: 'Failed', details: { componentFailures: [{ ...info, problemType: 'Error' }] } },
          1
        )
      )
    ).to.throw('Select a From address');
  });

  it('requires actual newly-created results for CREATE', () => {
    const create = { ...selection, operation: 'create' as const };
    expect(parseFlowResult(create, response({ ...success, checkOnly: false })).state).to.equal('succeeded');
    expect(() => parseFlowResult(create, response({ ...success, checkOnly: true }))).to.throw('newly created');
    expect(() =>
      parseFlowResult(
        create,
        response({ ...success, checkOnly: false, files: [{ ...success.files[0], state: 'Changed' }] })
      )
    ).to.throw('newly created');
    expect(() => buildFlowArgs(create)).to.throw('Unsupported');
  });

  it('retains unfinished job identity without claiming success or starting another deploy', () => {
    const pending = { id: 'job', status: 'InProgress', done: false, success: false };
    expect(parseFlowResult({ ...selection, operation: 'validate' }, response(pending, 69))).to.include({
      state: 'pending',
      coreExitCode: 69,
    });
    expect(parseFlowResult(selection, response(pending))).to.include({ state: 'pending' });
    expect(() => parseFlowResult(selection, response({ ...pending, done: true }))).to.throw();
    expect(() => parseFlowResult({ ...selection, operation: 'validate' }, response(pending))).to.throw();
  });

  it('runs from the configured project root, leaving multi-package paths to Core', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flow-cli-'));
    try {
      await writeFile(
        join(root, 'sfdx-project.json'),
        JSON.stringify({ packageDirectories: [{ path: 'custom', default: true }, { path: 'other' }] })
      );
      let calls = 0;
      const result = await runFlow({ ...selection, projectRoot: root }, async (args, cwd) => {
        calls++;
        expect(cwd).to.equal(root);
        expect(args).not.to.include('force-app').and.not.to.include('--output-dir');
        return Promise.resolve(response(success));
      });
      expect(result.state).to.equal('succeeded');
      expect(calls).to.equal(1);
      await writeFile(join(root, 'sfdx-project.json'), '{}');
      let rejected = false;
      try {
        await runFlow({ ...selection, projectRoot: root }, async () => {
          calls++;
          return Promise.resolve(response(success));
        });
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
      expect(calls).to.equal(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
