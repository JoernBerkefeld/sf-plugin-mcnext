import { open, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import FlowAssociation, { flowAssociationServices } from '../../../../src/commands/mcnext/flow/association.js';
import {
  FlowAssociationError,
  type FlowAssociationInput,
  type FlowAssociationResult,
} from '../../../../src/core/flowAssociation.js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
} from '../../../../src/filesystem/runOwnedTemp.js';

const id = (prefix: string, index = 1): string => `${prefix}${String(index).padStart(12, '0')}AAA`;
const selection = (): Pick<FlowAssociationInput, 'artifact' | 'source' | 'target'> => ({
  artifact: {
    schemaVersion: 1,
    kind: 'campaign-flow-associations',
    source: { orgId: id('00D'), campaignId: id('701'), apiVersion: '67.0' },
    flows: [
      {
        member: 'Source',
        flowRecordId: id('2aF'),
        associatedRecordId: id('701'),
        segmentId: id('1sg'),
        definitionId: id('300'),
        latestVersionId: id('301'),
        nativeFile: 'flows/Source.flow-meta.xml',
        nativeSha256: 'a'.repeat(64),
      },
    ],
  },
  source: { orgId: id('00D'), campaignId: id('701'), flowRecordId: id('2aF'), member: 'Source', segmentId: id('1sg') },
  target: {
    campaignId: id('701', 2),
    flowRecordId: id('2aF', 2),
    member: 'Target',
    segmentId: id('1sg', 2),
    segmentApiName: 'ExplicitSegment',
    segmentDefinitionId: id('3HX', 2),
    expectedDefinitionId: id('300', 2),
    expectedLatestVersionId: id('301', 2),
  },
});
const result = (
  state: FlowAssociationResult['state'],
  operation: FlowAssociationResult['operation']
): FlowAssociationResult => ({
  operation,
  state,
  orgId: id('00D', 2),
  campaignId: id('701', 2),
  flowRecordId: id('2aF', 2),
  segmentId: id('1sg', 2),
  definitionId: id('300', 2),
  latestVersionId: id('301', 2),
  writeAttempted: state === 'attached',
  writeOutcome: state === 'attached' ? 'acknowledged' : 'not-attempted',
});

async function failure(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected command rejection');
}

describe('mcnext flow association command', () => {
  const $$ = new TestContext();
  let run: Awaited<ReturnType<typeof createRunOwnedTemp>>;
  let project: string;
  let args: string[];
  let previousExit: typeof process.exitCode;
  beforeEach(async () => {
    previousExit = process.exitCode;
    process.exitCode = undefined;
    stubSfCommandUx($$.SANDBOX);
    run = await createRunOwnedTemp('flow-association-command');
    project = await createRunOwnedDirectory(run, 'project');
    await writeFile(join(project, 'input.json'), JSON.stringify(selection()), { flag: 'wx' });
    args = [
      '--operation',
      'plan',
      '--target-org',
      'explicit-target',
      '--expected-org-id',
      id('00D', 2),
      '--api-version',
      '67.0',
      '--project-dir',
      project,
      '--input-file',
      'input.json',
    ];
  });
  afterEach(async () => {
    $$.restore();
    process.exitCode = previousExit;
    await removeRunOwnedPath(run, project);
    await removeRunOwnedRoot(run);
  });

  it('requires every explicit flag and exposes only API67 plan/apply', () => {
    expect(FlowAssociation.flags.operation.options).to.deep.equal(['plan', 'apply']);
    expect(FlowAssociation.flags['api-version'].options).to.deep.equal(['67.0']);
    for (const flag of [
      'operation',
      'target-org',
      'expected-org-id',
      'api-version',
      'project-dir',
      'input-file',
    ] as const)
      expect(FlowAssociation.flags[flag].required).to.equal(true);
    expect(FlowAssociation.flags['output-file'].required).not.to.equal(true);
    expect(FlowAssociation.description).to.include('never generates business mappings');
  });

  for (const [state, operation] of [
    ['planned', 'plan'],
    ['attached', 'apply'],
    ['noop', 'apply'],
  ] as const) {
    it(`returns truthful ${state} human/JSON results, explicit bindings and allowlisted local output`, async () => {
      const expected = result(state, operation);
      const service = $$.SANDBOX.stub(flowAssociationServices, 'associateFlow').resolves({
        ...expected,
        secret: 'Bearer hidden',
      } as FlowAssociationResult);
      args[1] = operation;
      for (const json of [false, true]) {
        const name = json ? 'json-result.json' : 'human-result.json';
        // eslint-disable-next-line no-await-in-loop -- exercise command modes sequentially with distinct outputs
        const actual = await FlowAssociation.run([...args, '--output-file', name, ...(json ? ['--json'] : [])]);
        expect(actual).to.deep.equal(expected);
        // eslint-disable-next-line no-await-in-loop -- independently inspect each completed local output
        expect(JSON.parse(await readFile(join(project, name), 'utf8'))).to.deep.equal(expected);
        expect(process.exitCode).to.equal(undefined);
      }
      expect(service.callCount).to.equal(2);
      expect(service.firstCall.args[0]).to.deep.equal({
        ...selection(),
        operation,
        targetOrg: 'explicit-target',
        expectedOrgId: id('00D', 2),
        apiVersion: '67.0',
      });
      expect(service.firstCall.args.length).to.equal(1);
    });
  }

  for (const [code, attempted] of [
    ['INVALID_INPUT', false],
    ['BLOCKED', false],
    ['CONFLICT', false],
    ['RECONCILIATION_REQUIRED', true],
  ] as const) {
    it(`returns safe nonzero ${code} with truthful attempt evidence`, async () => {
      const service = $$.SANDBOX.stub(flowAssociationServices, 'associateFlow').rejects(
        new FlowAssociationError(code, attempted)
      );
      args[1] = 'apply';
      const actual = await FlowAssociation.run([...args, '--json', '--output-file', 'error-result.json']);
      expect(actual).to.deep.equal({
        operation: 'apply',
        state: 'failed',
        code,
        writeAttempted: attempted,
        writeOutcome: attempted ? 'unknown' : 'not-attempted',
      });
      expect(JSON.parse(await readFile(join(project, 'error-result.json'), 'utf8'))).to.deep.equal(actual);
      expect(process.exitCode).to.equal(1);
      expect(service.calledOnce).to.equal(true);
    });
  }

  it('redacts arbitrary prewrite transport and authentication failures', async () => {
    $$.SANDBOX.stub(flowAssociationServices, 'associateFlow').rejects(
      new Error('Bearer SECRET https://username:password@host')
    );
    const actual = await FlowAssociation.run([...args, '--json']);
    expect(actual).to.deep.equal({
      operation: 'plan',
      state: 'failed',
      code: 'BLOCKED',
      writeAttempted: false,
      writeOutcome: 'not-attempted',
    });
    expect(JSON.stringify(actual)).not.to.include('SECRET');
    expect(process.exitCode).to.equal(1);
  });

  it('rejects unsupported operations/API and missing required flags before service execution', async () => {
    const service = $$.SANDBOX.stub(flowAssociationServices, 'associateFlow');
    for (const invalid of [
      args.map((arg) => (arg === 'plan' ? 'activate' : arg)),
      args.map((arg) => (arg === '67.0' ? '66.0' : arg)),
      args.slice(0, -2),
    ]) {
      // eslint-disable-next-line no-await-in-loop -- parse failures must not overlap shared command state
      expect(await failure(() => FlowAssociation.run(invalid))).to.be.instanceOf(Error);
    }
    expect(service.called).to.equal(false);
  });

  it('rejects malformed, nonobject, missing and overriding input without leaking raw JSON', async () => {
    const service = $$.SANDBOX.stub(flowAssociationServices, 'associateFlow');
    for (const invalid of [
      'SECRET not JSON',
      '[]',
      'null',
      JSON.stringify({ ...selection(), targetOrg: 'override' }),
    ]) {
      // eslint-disable-next-line no-await-in-loop -- replace fixture only between completed invocations
      await writeFile(join(project, 'input.json'), invalid);
      // eslint-disable-next-line no-await-in-loop -- inspect each sanitized preflight failure
      const error = await failure(() => FlowAssociation.run(args));
      expect(error.message).to.include('preflight failed');
      expect(error.message).not.to.include('SECRET');
    }
    args[args.length - 1] = 'missing.json';
    expect((await failure(() => FlowAssociation.run(args))).message).to.include('preflight failed');
    expect(service.called).to.equal(false);
  });

  it('delegates missing correspondence to the sole schema validator without org calls', async () => {
    await writeFile(join(project, 'input.json'), '{}');
    const actual = await FlowAssociation.run(args);
    expect(actual).to.deep.equal({
      operation: 'plan',
      state: 'failed',
      code: 'INVALID_INPUT',
      writeAttempted: false,
      writeOutcome: 'not-attempted',
    });
    expect(process.exitCode).to.equal(1);
  });

  it('preflights collisions, escapes, missing parents and directory inputs before apply', async () => {
    const service = $$.SANDBOX.stub(flowAssociationServices, 'associateFlow');
    args[1] = 'apply';
    await writeFile(join(project, 'sentinel.json'), 'preserve');
    for (const output of ['sentinel.json', '../escape.json', 'missing/result.json', 'input.json']) {
      // eslint-disable-next-line no-await-in-loop -- ensure every preflight independently blocks the service
      expect((await failure(() => FlowAssociation.run([...args, '--output-file', output]))).message).to.include(
        'no org write attempted'
      );
    }
    expect(await readFile(join(project, 'sentinel.json'), 'utf8')).to.equal('preserve');
    args[args.length - 1] = project;
    expect((await failure(() => FlowAssociation.run(args))).message).to.include('preflight failed');
    expect(service.called).to.equal(false);
  });

  it('reports local output failure without losing a verified attachment result or retrying', async () => {
    const probe = await open(join(project, 'probe.json'), 'wx');
    const prototype = Object.getPrototypeOf(probe) as { writeFile: () => Promise<void> };
    await probe.close();
    $$.SANDBOX.stub(prototype, 'writeFile').rejects(new Error('secret local details'));
    const expected = result('attached', 'apply');
    const service = $$.SANDBOX.stub(flowAssociationServices, 'associateFlow').resolves(expected);
    args[1] = 'apply';
    const actual = await FlowAssociation.run([...args, '--output-file', 'failed-output.json', '--json']);
    expect(actual).to.deep.equal({
      operation: 'apply',
      state: 'failed',
      code: 'OUTPUT_WRITE_FAILED',
      writeAttempted: true,
      writeOutcome: 'unknown',
      associationResult: expected,
    });
    expect(service.calledOnce).to.equal(true);
    expect(process.exitCode).to.equal(1);
    expect(JSON.stringify(actual)).not.to.include('secret');
  });

  it('rejects linked/reparse ancestors before service execution', async () => {
    const service = $$.SANDBOX.stub(flowAssociationServices, 'associateFlow');
    await symlink(project, join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      args[args.length - 1] = 'linked/input.json';
      expect((await failure(() => FlowAssociation.run(args))).message).to.include('preflight failed');
      expect(service.called).to.equal(false);
    } finally {
      // Remove the link entry, not its target, before run-owned recursive cleanup.
      const { unlink } = await import('node:fs/promises');
      await unlink(join(project, 'linked'));
    }
  });
});
