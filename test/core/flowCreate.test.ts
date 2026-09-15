import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { assertInactiveFlowSource, createFlow } from '../../src/core/flowCreate.js';
import { type CoreRunner } from '../../src/core/flowCli.js';

export const fixture =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>67.0</apiVersion><assignments><name>SetMarker</name><label>Set Marker</label><locationX>0</locationX><locationY>0</locationY><assignmentItems><assignToReference>marker</assignToReference><operator>Assign</operator><value><stringValue>Bounded proof</stringValue></value></assignmentItems></assignments><interviewLabel>MVP Flow</interviewLabel><label>MVP Flow</label><processType>AutoLaunchedFlow</processType><start><locationX>0</locationX><locationY>0</locationY><connector><targetReference>SetMarker</targetReference></connector></start><status>Draft</status><variables><name>marker</name><dataType>String</dataType><isCollection>false</isCollection><isInput>false</isInput><isOutput>false</isOutput></variables></Flow>';
const member = 'AnnualPromoCopy';
const orgId = '00D000000000000AAA';
const response = (result: unknown, exitCode = 0): { stdout: string; exitCode: number } => ({
  stdout: JSON.stringify({ status: exitCode, result }),
  exitCode,
});

describe('bounded Flow CREATE', () => {
  it('accepts inactive source but rejects active definitions, ambiguous status and malformed XML', async () => {
    await assertInactiveFlowSource(fixture);
    await assertInactiveFlowSource(fixture.replace('Draft', 'InvalidDraft'));
    await Promise.all(
      [
        fixture.replace('Draft', 'Active'),
        fixture.replace('</Flow>', '<activeVersionNumber>1</activeVersionNumber></Flow>'),
        fixture.replace('</Flow>', '<status>Active</status></Flow>'),
        fixture.replace('<Flow ', '<!DOCTYPE x><Flow '),
        fixture.replace('AutoLaunchedFlow', 'Scheduled'),
        fixture.replace('</Flow>', ''),
      ].map(async (xml) => {
        let error: unknown;
        try {
          await assertInactiveFlowSource(xml);
        } catch (caught) {
          error = caught;
        }
        expect(error).to.be.instanceOf(Error);
      })
    );
  });

  it('rejects invalid names, identity, wait and unsafe package paths before any CLI call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flow-create-guards-'));
    try {
      await writeFile(
        join(root, 'sfdx-project.json'),
        JSON.stringify({ packageDirectories: [{ path: '../outside' }] })
      );
      const base = {
        projectRoot: root,
        targetOrg: 'target',
        expectedOrgId: orgId,
        sourceOrgId: orgId,
        reuseSameOrgReferences: true,
        member,
        sourceFile: '../outside/source.flow-meta.xml',
      };
      let calls = 0;
      await Promise.all(
        [
          { member: 'Bad__Name' },
          { member: 'Bad_' },
          { member: 'A'.repeat(81) },
          { expectedOrgId: 'wrong' },
          { sourceOrgId: '00D000000000001AAA' },
          { reuseSameOrgReferences: false },
          { targetOrg: '--all' },
          { waitMinutes: 0 },
          {},
        ].map(async (patch) => {
          let error: unknown;
          try {
            await createFlow({ ...base, ...patch }, async () => {
              calls++;
              return response({});
            });
          } catch (caught) {
            error = caught;
          }
          expect(error).to.be.instanceOf(Error);
        })
      );
      expect(calls).to.equal(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const scenario of [
    'success',
    'conflict',
    'late-conflict',
    'wrong-org',
    'incomplete',
    'pending-validation',
    'failed-create',
    'pending-create',
    'bad-source',
  ] as const) {
    it(`handles ${scenario} without implicit upsert or unsafe apply`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'flow-create-test-'));
      const calls: string[][] = [];
      try {
        await mkdir(join(root, 'custom'), { recursive: true });
        await writeFile(
          join(root, 'sfdx-project.json'),
          JSON.stringify({ packageDirectories: [{ path: 'custom', default: true }, { path: 'other' }] })
        );
        const source = await readFile('test/core/fixtures/segment-email.flow-meta.xml', 'utf8');
        await writeFile(
          join(root, 'custom', 'source.flow-meta.xml'),
          scenario === 'bad-source' ? fixture.replace('Draft', 'Active') : source
        );
        let absence = 0;
        const runner: CoreRunner = async (args, cwd) => {
          calls.push(args);
          if (args[0] === 'data') {
            const org = args.includes('SELECT Id FROM Organization');
            if (!org) absence++;
            const records = org
              ? [{ Id: scenario === 'wrong-org' ? 'wrong' : orgId }]
              : scenario === 'conflict' || (scenario === 'late-conflict' && absence === 2)
              ? [{ Id: 'exists' }]
              : [];
            return response({ records, totalSize: records.length, done: scenario !== 'incomplete' });
          }
          expect(cwd).not.to.equal(root);
          expect(await readFile(join(cwd, 'custom/main/default/flows', `${member}.flow-meta.xml`), 'utf8')).to.equal(
            source
          );
          expect(args).to.include(`Flow:${member}`).and.not.to.include('--ignore-conflicts');
          const dry = args.includes('--dry-run');
          const pending = (dry && scenario === 'pending-validation') || (!dry && scenario === 'pending-create');
          if (pending) return response({ id: 'job', status: 'InProgress', done: false, success: false }, 69);
          return response({
            id: 'job',
            checkOnly: dry,
            status: !dry && scenario === 'failed-create' ? 'Failed' : 'Succeeded',
            done: true,
            success: true,
            files: [{ type: 'Flow', fullName: member, state: 'Created', filePath: 'custom/flow' }],
          });
        };
        let error: unknown;
        let state: string | undefined;
        try {
          state = (
            await createFlow(
              {
                projectRoot: root,
                targetOrg: 'target',
                expectedOrgId: orgId,
                sourceOrgId: orgId,
                reuseSameOrgReferences: true,
                member,
                sourceFile: 'custom/source.flow-meta.xml',
              },
              runner
            )
          ).state;
        } catch (caught) {
          error = caught;
        }
        const apply = calls.filter((args) => args[0] === 'project' && !args.includes('--dry-run'));
        if (scenario === 'success' || scenario === 'pending-create') {
          expect(error).to.equal(undefined);
          expect(state).to.equal(scenario === 'success' ? 'succeeded' : 'pending');
          expect(apply.length).to.equal(1);
        } else {
          expect(error).to.be.instanceOf(Error);
          expect(apply.length).to.equal(scenario === 'failed-create' ? 1 : 0);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
