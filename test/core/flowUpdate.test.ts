import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { updateFlow } from '../../src/core/flowCreate.js';
import { type CoreRunner } from '../../src/core/flowCli.js';

const member = 'ExistingFlow';
const orgId = '00D000000000000AAA';
const definition = '300000000000000AAA';
const version = '301000000000000AAA';
const response = (result: unknown, exitCode = 0): { stdout: string; exitCode: number } => ({
  stdout: JSON.stringify({ status: exitCode, result }),
  exitCode,
});

describe('explicit inactive Flow UPDATE', () => {
  for (const scenario of [
    'success',
    'unchanged',
    'missing',
    'late-missing',
    'wrong-org',
    'wrong-definition',
    'wrong-version',
    'active',
    'active-version',
    'changed-baseline',
    'active-source',
    'pending-validation',
    'pending-update',
    'failed-update',
    'created-result',
    'check-only-result',
    'missing-ids',
  ] as const) {
    it(`handles ${scenario} without fallback, rename or activation`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'flow-update-test-'));
      const calls: string[][] = [];
      const info = { problemType: 'Info', problem: 'Draft prerequisites remain' };
      try {
        await mkdir(join(root, 'custom'));
        await writeFile(join(root, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'custom' }] }));
        const source = await readFile('test/core/fixtures/segment-email.flow-meta.xml', 'utf8');
        await writeFile(
          join(root, 'custom/source.flow-meta.xml'),
          scenario === 'active-source' ? source.replace('InvalidDraft', 'Active') : source
        );
        let checks = 0;
        const runner: CoreRunner = async (args, cwd) => {
          calls.push(args);
          if (args[0] === 'data') {
            const soql = args[args.indexOf('--query') + 1];
            let records: Array<Record<string, unknown>>;
            if (soql.includes('Organization')) records = [{ Id: scenario === 'wrong-org' ? 'wrong' : orgId }];
            else if (soql.includes('FlowDefinition')) {
              checks++;
              records =
                scenario === 'missing' || (scenario === 'late-missing' && checks === 2)
                  ? []
                  : [
                      {
                        Id: scenario === 'wrong-definition' ? 'wrong' : definition,
                        LatestVersionId: scenario === 'wrong-version' ? 'wrong' : version,
                        ActiveVersionId: scenario === 'active' ? version : null,
                      },
                    ];
            } else
              records = [
                {
                  Id: version,
                  Status: scenario === 'active-version' ? 'Active' : 'InvalidDraft',
                  LastModifiedDate: scenario === 'changed-baseline' && checks === 2 ? 'changed' : 'baseline',
                },
              ];
            return response({ records, totalSize: records.length, done: true });
          }
          expect(cwd).not.to.equal(root);
          expect(await readFile(join(cwd, 'custom/main/default/flows', `${member}.flow-meta.xml`), 'utf8')).to.equal(
            source
          );
          expect(args).to.include(`Flow:${member}`).and.not.to.include('--activate');
          const dry = args.includes('--dry-run');
          if ((dry && scenario === 'pending-validation') || (!dry && scenario === 'pending-update'))
            return response({ id: 'job', status: 'InProgress', done: false }, 69);
          const state =
            new Map([
              ['created-result', 'Created'],
              ['unchanged', 'Unchanged'],
            ]).get(scenario) ?? 'Changed';
          return response({
            id: 'job',
            checkOnly: [dry, scenario === 'check-only-result'].includes(true),
            status: [!dry, scenario === 'failed-update'].every(Boolean) ? 'Failed' : 'Succeeded',
            done: true,
            success: true,
            details: { componentSuccesses: [info] },
            files: [{ type: 'Flow', fullName: member, filePath: 'custom/flow', state }],
          });
        };
        let error: unknown;
        let result;
        try {
          result = await updateFlow(
            {
              projectRoot: root,
              targetOrg: 'target',
              expectedOrgId: orgId,
              sourceOrgId: orgId,
              reuseSameOrgReferences: true,
              member,
              sourceFile: 'custom/source.flow-meta.xml',
              expectedDefinitionId: scenario === 'missing-ids' ? '' : definition,
              expectedLatestVersionId: version,
            },
            runner
          );
        } catch (caught) {
          error = caught;
        }
        const apply = calls.filter((args) => args[0] === 'project' && !args.includes('--dry-run'));
        if (['success', 'unchanged', 'pending-update'].includes(scenario)) {
          expect(error).to.equal(undefined);
          expect(result?.state).to.equal(scenario === 'pending-update' ? 'pending' : 'succeeded');
          expect(result?.operation).to.equal('update');
          expect(result?.diagnostics).to.deep.equal(scenario === 'pending-update' ? [info] : [info, info]);
          expect(apply).to.have.length(1);
        } else {
          expect(error).to.be.instanceOf(Error);
          expect(apply).to.have.length(
            ['failed-update', 'created-result', 'check-only-result'].includes(scenario) ? 1 : 0
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
