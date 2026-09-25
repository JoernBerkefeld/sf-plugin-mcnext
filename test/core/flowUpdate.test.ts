import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'chai';
import { updateFlow } from '../../src/core/flowCreate.js';
import { type CoreRunner } from '../../src/core/flowCli.js';

const member = 'ExistingFlow';
const orgId = '00D000000000000AAA';
const definition = '300000000000000AAA';
const version = '301000000000000AAA';
const replacementVersion = '301000000000001AAA';
const response = (result: unknown, exitCode = 0): { stdout: string; exitCode: number } => ({
  stdout: JSON.stringify({ status: exitCode, result }),
  exitCode,
});

async function retrievedFlowResponse(flowPath: string, source?: string) {
  if (source !== undefined) {
    await mkdir(dirname(flowPath), { recursive: true });
    await writeFile(flowPath, source);
  }
  return response({
    id: 'retrieve-job',
    checkOnly: false,
    status: 'Succeeded',
    done: true,
    success: true,
    files: [{ type: 'Flow', fullName: member, filePath: flowPath, state: 'Changed' }],
  });
}

describe('explicit inactive Flow UPDATE', () => {
  for (const scenario of [
    'success',
    'label-only',
    'interview-label-only',
    'exact-equal-normal',
    'normal-update-unchanged',
    'unchanged',
    'expected-unchanged-changed',
    'readback-mismatch',
    'missing-baseline',
    'malformed-baseline',
    'unrelated-source-change',
    'stripped-source-change',
    'unchanged-source-mismatch',
    'missing-readback',
    'active-after',
    'latest-version-after',
    'replacement-active',
    'pending-reconciliation',
    'pending-before-apply',
    'pending-after-readback',
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
        const submittedSource =
          scenario === 'active-source'
            ? source.replace('InvalidDraft', 'Active')
            : scenario === 'unrelated-source-change'
            ? source.replace('<publishSegment>true</publishSegment>', '<publishSegment>false</publishSegment>')
            : scenario === 'stripped-source-change'
            ? source.replace(/\s*<processMetadataValues><name>CanvasMode<\/name>[\s\S]*?<\/processMetadataValues>/, '')
            : source;
        await writeFile(join(root, 'custom/source.flow-meta.xml'), submittedSource);
        let checks = 0;
        let deploymentChecks = 0;
        let retrievals = 0;
        // eslint-disable-next-line complexity -- scenario matrix intentionally exercises all Flow safety branches in one transport
        const runner: CoreRunner = async (args, cwd) => {
          calls.push(args);
          if (args[0] === 'data') {
            const soql = args[args.indexOf('--query') + 1];
            let records: Array<Record<string, unknown>>;
            if (soql.includes('Organization')) records = [{ Id: scenario === 'wrong-org' ? 'wrong' : orgId }];
            else if (soql.includes('DeployRequest')) {
              deploymentChecks++;
              const pendingAt = new Map([
                ['pending-reconciliation', 1],
                ['pending-before-apply', 2],
                ['pending-after-readback', 3],
              ]).get(scenario);
              records = deploymentChecks === pendingAt ? [{ Id: '0Af000000000000AAA', Status: 'InProgress' }] : [];
            } else if (soql.includes('FlowDefinition')) {
              checks++;
              const latestAfterApply =
                checks >= 3 &&
                !['unchanged', 'expected-unchanged-changed', 'pending-after-readback'].includes(scenario);
              records =
                scenario === 'missing' || (scenario === 'late-missing' && checks === 2)
                  ? []
                  : [
                      {
                        Id: scenario === 'wrong-definition' ? 'wrong' : definition,
                        LatestVersionId:
                          scenario === 'wrong-version'
                            ? 'wrong'
                            : scenario === 'latest-version-after' && checks >= 4
                            ? '301000000000002AAA'
                            : latestAfterApply
                            ? replacementVersion
                            : version,
                        ActiveVersionId:
                          scenario === 'active' || (scenario === 'active-after' && checks >= 3) ? version : null,
                      },
                    ];
            } else {
              const queriedVersion = soql.includes(replacementVersion) ? replacementVersion : version;
              records = [
                {
                  Id: queriedVersion,
                  Status:
                    scenario === 'active-version' || (scenario === 'replacement-active' && queriedVersion === replacementVersion)
                      ? 'Active'
                      : 'InvalidDraft',
                  LastModifiedDate: scenario === 'changed-baseline' && checks === 2 ? 'changed' : 'baseline',
                },
              ];
            }
            return response({ records, totalSize: records.length, done: true });
          }
          expect(cwd).not.to.equal(root);
          const flowPath = join(cwd, 'custom/main/default/flows', `${member}.flow-meta.xml`);
          if (args[1] !== 'retrieve') expect(await readFile(flowPath, 'utf8')).to.equal(submittedSource);
          expect(args).to.include(`Flow:${member}`).and.not.to.include('--activate');
          const retrieve = args[1] === 'retrieve';
          if (retrieve) {
            retrievals++;
            const labels =
              '<interviewLabel>Example Flow {!$Flow.CurrentDateTime}</interviewLabel><label>Example Flow</label>';
            const baselineSource =
              new Map([
                ['unchanged', source],
                ['exact-equal-normal', source],
                [
                  'label-only',
                  source.replace(
                    labels,
                    '<interviewLabel>Example Flow {!$Flow.CurrentDateTime}</interviewLabel><label>Baseline Flow</label>'
                  ),
                ],
                [
                  'interview-label-only',
                  source.replace(
                    labels,
                    '<interviewLabel>Baseline Flow {!$Flow.CurrentDateTime}</interviewLabel><label>Example Flow</label>'
                  ),
                ],
              ]).get(scenario) ??
              source.replace(
                labels,
                '<interviewLabel>Baseline Flow {!$Flow.CurrentDateTime}</interviewLabel><label>Baseline Flow</label>'
              );
            if (retrievals === 1) {
              if (scenario === 'missing-baseline') return retrievedFlowResponse(flowPath);
              if (scenario === 'malformed-baseline') return retrievedFlowResponse(flowPath, '<Flow>');
              return retrievedFlowResponse(flowPath, baselineSource);
            }
            if (scenario === 'missing-readback') return retrievedFlowResponse(flowPath);
            return retrievedFlowResponse(
              flowPath,
              scenario === 'readback-mismatch' ? source.replace('InvalidDraft', 'Draft') : source
            );
          }
          const dry = args.includes('--dry-run');
          if ((dry && scenario === 'pending-validation') || (!dry && scenario === 'pending-update'))
            return response({ id: 'job', status: 'InProgress', done: false }, 69);
          const state =
            new Map([
              ['created-result', 'Created'],
              ['unchanged', 'Unchanged'],
              ['normal-update-unchanged', 'Unchanged'],
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
              expectUnchanged: ['unchanged', 'expected-unchanged-changed', 'unchanged-source-mismatch'].includes(
                scenario
              ),
            },
            runner
          );
        } catch (caught) {
          error = caught;
        }
        const apply = calls.filter(
          (args) => args[0] === 'project' && args[1] === 'deploy' && !args.includes('--dry-run')
        );
        if (['success', 'label-only', 'interview-label-only', 'unchanged', 'pending-update'].includes(scenario)) {
          expect(error).to.equal(undefined);
          expect(result?.state).to.equal(scenario === 'pending-update' ? 'pending' : 'succeeded');
          expect(result?.operation).to.equal('update');
          expect(result?.diagnostics).to.deep.equal(scenario === 'pending-update' ? [info] : [info, info]);
          expect(apply).to.have.length(1);
        } else {
          expect(error).to.be.instanceOf(Error);
          expect(apply).to.have.length(
            [
              'failed-update',
              'created-result',
              'check-only-result',
              'readback-mismatch',
              'missing-readback',
              'active-after',
              'latest-version-after',
              'replacement-active',
              'pending-after-readback',
              'normal-update-unchanged',
            ].includes(scenario)
              ? 1
              : 0
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
