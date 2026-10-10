import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import RetrieveAll, { retrieveAllServices } from '../../../../src/commands/mcnext/retrieve/all.js';
import {
  projectRetrieveAllResult,
  type RetrieveAllResult,
  type RetrieveAllState,
} from '../../../../src/registry/retrieveAll.js';

const args = ['--target-org', 'source', '--expected-org-id', '00D000000000001AAA', '--project-dir', '.'];

function outcome(state: RetrieveAllState): RetrieveAllResult {
  return {
    state,
    complete: false,
    files: ['mcnext/campaigns/Example.mcn-campaign.json'],
    diagnostics: ['Not a full backup'],
    providers: [
      {
        provider: 'core-sf',
        family: 'campaign-flows:701000000000001AAA',
        state: 'pending',
        files: [],
        diagnostics: ['Pending native work'],
        stagingDirectory: '/retained-stage',
        retainedRoot: '/retained-root',
        jobId: '0Af000000000001AAA',
        result: {
          state: 'pending',
          files: [],
          members: ['Example'],
          associationPersistence: 'blocked',
          stagingOwner: { secret: 'PRIVATE-OWNER' },
          rawTransport: Buffer.from('PRIVATE-BUFFER'),
          token: 'PRIVATE-TOKEN',
        } as unknown as NonNullable<RetrieveAllResult['providers'][number]['result']>,
      },
      {
        provider: 'core-sf',
        family: 'native-segments',
        state: 'blocked',
        files: [],
        diagnostics: ['Native completeness unqualified'],
      },
    ],
  };
}

describe('mcnext retrieve all command', () => {
  const $$ = new TestContext();
  const priorExitCode = process.exitCode;
  let ux: ReturnType<typeof stubSfCommandUx>;
  beforeEach(() => {
    process.exitCode = 0;
    ux = stubSfCommandUx($$.SANDBOX);
  });
  afterEach(() => {
    $$.restore();
    process.exitCode = priorExitCode;
  });

  for (const json of [false, true]) {
    it(`routes explicit context and exposes only safe projection in ${json ? 'JSON' : 'human'} output`, async () => {
      const internal = outcome('partial');
      const call = $$.SANDBOX.stub(retrieveAllServices, 'retrieveAll').resolves(internal);
      const log = ux.log;
      const actual = await RetrieveAll.run([...args, '--wait', '3', ...(json ? ['--json'] : [])]);
      expect(
        call.calledOnceWithExactly({
          projectRoot: resolve('.'),
          targetOrg: 'source',
          expectedOrgId: '00D000000000001AAA',
          apiVersion: '67.0',
          waitMinutes: 3,
        })
      ).to.equal(true);
      expect(actual).to.deep.equal(projectRetrieveAllResult(internal));
      expect(process.exitCode).to.equal(2);
      const returned = JSON.stringify(actual);
      const printed = log.args.map((entry) => String(entry[0])).join('\n');
      for (const forbidden of [
        'PRIVATE-OWNER',
        'PRIVATE-BUFFER',
        'PRIVATE-TOKEN',
        'stagingOwner',
        'rawTransport',
        '"type":"Buffer"',
      ]) {
        expect(returned).not.to.include(forbidden);
        expect(printed).not.to.include(forbidden);
      }
      expect(printed).to.include('complete: false').and.include('Not a full backup').and.include('partial');
      expect(printed).to.include(internal.files[0]).and.include('native-segments: blocked');
      expect(printed).to.include('/retained-stage').and.include('0Af000000000001AAA');
      expect(printed).to.include('Retained temporary root: /retained-root');
      expect(actual.providers[0].evidence).to.deep.equal({ members: ['Example'], associationPersistence: 'blocked' });
      expect(internal.providers[0].result).to.have.property('stagingOwner');
    });
  }

  for (const [state, code] of [
    ['success', 0],
    ['partial', 2],
    ['blocked', 1],
    ['failed', 1],
    ['pending', 69],
  ] as const) {
    it(`returns structured ${state} with exit ${code} and resets stale exit state`, async () => {
      process.exitCode = 69;
      const internal = outcome(state);
      if (state === 'blocked' || state === 'failed') internal.files = [];
      const call = $$.SANDBOX.stub(retrieveAllServices, 'retrieveAll').resolves(internal);
      const actual = await RetrieveAll.run(args);
      expect(actual.state).to.equal(state);
      expect(actual.files).to.deep.equal(internal.files);
      expect(actual.complete).to.equal(false);
      expect(process.exitCode).to.equal(code);
      expect(call.firstCall.args[0].waitMinutes).to.equal(10);
    });
  }

  it('rejects invalid flags and context before invoking providers', async () => {
    const call = $$.SANDBOX.stub(retrieveAllServices, 'retrieveAll');
    const invalid = [
      args.filter((_, index) => index !== 0 && index !== 1),
      args.filter((_, index) => index !== 2 && index !== 3),
      args.filter((_, index) => index !== 4 && index !== 5),
      [...args, '--api-version', '68.0'],
      [...args, '--wait', '0'],
      [...args, '--wait', '31'],
      [...args, '--wait', '1.5'],
      [...args, '--all'],
      [...args, '--overwrite'],
      ['--target-org', ' ', ...args.slice(2)],
      ['--target-org', 'source', '--expected-org-id', 'invalid', ...args.slice(4)],
      [...args.slice(0, 4), '--project-dir', 'missing-retrieve-all-project'],
    ];
    for (const selection of invalid) {
      let failure: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop -- isolated parse checks must not share command exit state
        await RetrieveAll.run(selection);
      } catch (error) {
        failure = error;
      }
      expect(failure, selection.join(' ')).to.be.instanceOf(Error);
    }
    expect(call.called).to.equal(false);
  });

  it('registers canonical command, alias and bounded help in the generated manifest', async () => {
    const manifest = JSON.parse(await readFile('oclif.manifest.json', 'utf8')) as {
      commands: Record<string, { aliases: string[]; description: string; flags: Record<string, unknown> }>;
    };
    const command = manifest.commands['mcnext:retrieve:all'];
    expect(command.aliases).to.include('mcn:retrieve:all');
    expect(command.description).to.include('complete:false').and.include('Marketing-only');
    for (const flag of ['target-org', 'expected-org-id', 'project-dir', 'api-version', 'wait', 'json'])
      expect(command.flags).to.have.property(flag);
    expect(RetrieveAll.flags['api-version'].default).to.equal('67.0');
    for (const flag of ['target-org', 'expected-org-id', 'project-dir'] as const)
      expect(RetrieveAll.flags[flag].required).to.equal(true);
  });
});
