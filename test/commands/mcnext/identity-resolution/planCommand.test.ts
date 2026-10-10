import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'chai';
import IdentityResolutionPlanCommand, {
  identityResolutionPlanServices,
} from '../../../../src/commands/mcnext/identity-resolution/plan.js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
  type RunOwnedTemp,
} from '../../../../src/filesystem/runOwnedTemp.js';

const sourceOrgId = '00D000000000001AAA';
const targetOrgId = '00D000000000002AAA';
const fixture = {
  configuration: {
    label: 'Marketing',
    dataSpaceName: 'space',
    objectApiName: 'Individual__dlm',
    filters: [],
    matchRules: [],
    reconciliationRules: [],
  },
  mappings: [],
};

describe('mcnext identity-resolution plan command', () => {
  let run: RunOwnedTemp;
  let directory: string;
  let sentinel: string;
  const originalResolve = identityResolutionPlanServices.resolveExpectedOrgIdentity;
  const originalReadInput = identityResolutionPlanServices.readInput;
  const originalCreateOrg = identityResolutionPlanServices.createOrg;
  const originalCreate = identityResolutionPlanServices.createClient;

  beforeEach(async () => {
    run = await createRunOwnedTemp('mcnext-identity-plan-command');
    directory = await createRunOwnedDirectory(run, 'fixture');
    sentinel = join(run.root, 'sentinel.txt');
    await writeFile(sentinel, 'sibling-survives');
  });

  afterEach(async () => {
    identityResolutionPlanServices.resolveExpectedOrgIdentity = originalResolve;
    identityResolutionPlanServices.readInput = originalReadInput;
    identityResolutionPlanServices.createOrg = originalCreateOrg;
    identityResolutionPlanServices.createClient = originalCreate;
    await removeRunOwnedPath(run, directory);
    expect(await lstat(directory).catch((error: NodeJS.ErrnoException) => error.code)).to.equal('ENOENT');
    expect(await readFile(sentinel, 'utf8')).to.equal('sibling-survives');
    await unlink(sentinel);
    await removeRunOwnedRoot(run);
    expect(await lstat(run.root).catch((error: NodeJS.ErrnoException) => error.code)).to.equal('ENOENT');
  });

  it('requires explicit intent and separate source and target identity guards before GET discovery', async () => {
    const inputFile = join(directory, 'input.json');
    await writeFile(inputFile, JSON.stringify(fixture));
    const calls: string[] = [];
    identityResolutionPlanServices.resolveExpectedOrgIdentity = async (expected) => {
      calls.push(`guard:${expected.role}:${expected.expectedOrgId}`);
      return { orgId: expected.expectedOrgId };
    };
    identityResolutionPlanServices.createOrg = async (targetOrg) => {
      calls.push(`org:${targetOrg}`);
      return {} as never;
    };
    identityResolutionPlanServices.createClient = async () =>
      ({
        request: async (request: { path: string; method?: string }) => {
          calls.push(`${request.method ?? 'GET'}:${request.path}`);
          return { identityResolutions: [] };
        },
      } as never);

    const result = await IdentityResolutionPlanCommand.run([
      '--intent',
      'create',
      '--source-org',
      'source',
      '--target-org',
      'target',
      '--expected-source-org-id',
      sourceOrgId,
      '--expected-target-org-id',
      targetOrgId,
      '--input-file',
      inputFile,
      '--api-version',
      '67.0',
      '--json',
    ]);

    expect(calls).to.deep.equal([
      `guard:source:${sourceOrgId}`,
      `guard:target:${targetOrgId}`,
      'org:target',
      'GET:/ssot/identity-resolutions',
    ]);
    expect(result.intent).to.equal('create');
    expect(result.mutationFree).to.equal(true);
    expect(result).not.to.have.property('prospectiveRequestBody');
    expect(JSON.stringify(result)).not.to.include(sourceOrgId).and.not.to.include(targetOrgId);
  });

  it('rejects equal resolved org IDs before reading input or creating target discovery', async () => {
    const inputFile = join(directory, 'input.json');
    await writeFile(inputFile, JSON.stringify(fixture));
    const calls: string[] = [];
    identityResolutionPlanServices.resolveExpectedOrgIdentity = async (expected) => {
      calls.push(`guard:${expected.role}`);
      return { orgId: sourceOrgId };
    };
    identityResolutionPlanServices.readInput = async () => {
      calls.push('input');
      return fixture;
    };
    identityResolutionPlanServices.createOrg = async () => {
      calls.push('org');
      return {} as never;
    };
    identityResolutionPlanServices.createClient = async () => {
      calls.push('client');
      return {} as never;
    };

    let error: unknown;
    try {
      await IdentityResolutionPlanCommand.run([
        '--intent',
        'create',
        '--source-org',
        'source',
        '--target-org',
        'target',
        '--expected-source-org-id',
        sourceOrgId,
        '--expected-target-org-id',
        sourceOrgId,
        '--input-file',
        inputFile,
        '--json',
      ]);
    } catch (caught) {
      error = caught;
    }

    expect(String(error)).to.include('Source and target org IDs must be different');
    expect(calls).to.deep.equal(['guard:source', 'guard:target']);
  });

  it('requires all exact update target expectations before either org guard or discovery', async () => {
    const inputFile = join(directory, 'input.json');
    await writeFile(inputFile, JSON.stringify(fixture));
    let guardCalls = 0;
    identityResolutionPlanServices.resolveExpectedOrgIdentity = async () => {
      guardCalls++;
      return { orgId: sourceOrgId };
    };
    let error: unknown;
    try {
      await IdentityResolutionPlanCommand.run([
        '--intent',
        'update-shell',
        '--source-org',
        'source',
        '--target-org',
        'target',
        '--expected-source-org-id',
        sourceOrgId,
        '--expected-target-org-id',
        targetOrgId,
        '--target-ruleset-id',
        '1iraj000000VkBeAAK',
        '--input-file',
        inputFile,
        '--json',
      ]);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.include('requires exact ruleset ID, label, key and status');
    expect(guardCalls).to.equal(0);
  });
});
