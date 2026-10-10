import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Org } from '@salesforce/core';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  cloneFixture,
  currentRegistryInfoFixture,
  partialFailedExportFixture,
  validExportFixture,
} from '../cms/contractFixtures.js';
import { CMS_REGISTRY_INFO_ARGS, buildCmsExportArgs } from '../../src/cms/cmsCli.js';
import type { McnClient } from '../../src/client/mcnClient.js';
import type { CoreRunner } from '../../src/core/flowCli.js';
import { createRunOwnedDirectory, createRunOwnedTemp, type RunOwnedTemp } from '../../src/filesystem/runOwnedTemp.js';
import {
  projectRetrieveAllResult,
  retrieveAll,
  type RetrieveAllInput,
  type RetrieveAllServices,
} from '../../src/registry/retrieveAll.js';

describe('real retrieve-all execution', () => {
  let owner: RunOwnedTemp;
  let input: RetrieveAllInput;
  let services: RetrieveAllServices;
  let calls: string[];
  const orgId = '00D000000000001AAA';
  const campaignId = '701000000000001AAA';
  const success = (result: unknown): { stdout: string; exitCode: number } => ({
    stdout: JSON.stringify({ status: 0, result }),
    exitCode: 0,
  });
  before(async () => {
    owner = await createRunOwnedTemp('mcnext-retrieve-all-tests');
  });
  beforeEach(async () => {
    const projectRoot = await createRunOwnedDirectory(owner, `project-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(projectRoot, 'native'));
    await writeFile(
      join(projectRoot, 'sfdx-project.json'),
      '{"packageDirectories":[{"path":"native","default":true}]}\n'
    );
    input = { projectRoot, targetOrg: 'selected', expectedOrgId: orgId, apiVersion: '67.0' };
    calls = [];
    const core: CoreRunner = async (args, cwd) => {
      expect(cwd).to.equal(projectRoot);
      expect(args.slice(-5)).to.deep.equal(['--target-org', 'selected', '--api-version', '67.0', '--json']);
      const query = args[args.indexOf('--query') + 1];
      if (args[0] === 'sobject') {
        calls.push('describe');
        return success({
          name: args[args.indexOf('--sobject') + 1],
          queryable: true,
          fields: (args[args.indexOf('--sobject') + 1] === 'Campaign'
            ? ['Id', 'Name']
            : ['Id', 'ApiName', 'AssociatedRecordId', 'SegmentId']
          ).map((name) => ({ name, type: 'string' })),
          childRelationships: [{ relationshipName: 'Flows', childSObject: 'FlowRecord', field: 'AssociatedRecordId' }],
        });
      }
      if (args.includes('--record-id')) {
        calls.push('snapshot-read');
        return success({ Id: campaignId, Name: 'Exact Campaign' });
      }
      calls.push(query);
      const records =
        query === 'SELECT Id FROM Organization'
          ? [{ Id: orgId }]
          : query === 'SELECT Id FROM Campaign ORDER BY Id LIMIT 101'
          ? [{ Id: campaignId }]
          : [];
      return success({ done: true, totalSize: records.length, records });
    };
    services = {
      core,
      createOrg: async () => ({ getOrgId: () => orgId } as Org),
      createClient: async () =>
        ({
          apiVersion: '67.0',
          request: async () => ({ identityResolutions: [], unchanged: { value: null } }),
        } as unknown as McnClient),
      marketingCms: async () => ({
        retrieval: {
          provider: 'sf-plugin-cms',
          workspaceType: 'Marketing',
          state: 'blocked',
          publication: 'not-attempted',
          diagnostics: [{ code: 'DEPENDENCY', message: 'CMS compatibility unqualified', retryable: false }],
        },
        publication: {
          provider: 'sf-plugin-cms',
          workspaceType: 'Marketing',
          state: 'blocked',
          publication: 'blocked',
          files: [],
          workspaces: [],
          diagnostics: [],
        },
      }),
    };
  });
  afterEach(() => sinon.restore());

  it('composes real Campaign, fresh Flow, correlation and identity defaults with original bytes', async () => {
    const result = await retrieveAll(input, services);
    expect(result.state).to.equal('partial');
    expect(result.complete).to.equal(false);
    expect(result.files).to.deep.equal([
      join(input.projectRoot, 'mcnext', 'campaigns', 'Exact Campaign.mcn-campaign.json'),
      join(input.projectRoot, 'data', 'identity-resolution.json'),
    ]);
    expect(JSON.parse(await readFile(result.files[0], 'utf8'))).to.deep.equal({
      Id: campaignId,
      Name: 'Exact Campaign',
    });
    expect(JSON.parse(await readFile(result.files[1], 'utf8'))).to.deep.equal({
      identityResolutions: [],
      unchanged: { value: null },
    });
    expect(calls.filter((call) => call === 'snapshot-read')).to.have.length(3);
    expect(result.providers.find((row) => row.family === `campaign-flows:${campaignId}`)?.state).to.equal('success');
    expect(result.providers.find((row) => row.family === `segment-correlation:${campaignId}`)?.state).to.equal(
      'success'
    );
    expect(result.providers.filter((row) => row.state === 'blocked').map((row) => row.family)).to.include.members([
      'native-segments',
      'campaign-association-persistence',
      'native-data-graphs',
      'native-identity-configuration',
    ]);
  });

  it('rejects fresh org mismatch before any provider effects', async () => {
    services.createOrg = async () => ({ getOrgId: () => '00D000000000002AAA' } as Org);
    const result = await retrieveAll(input, services);
    expect(result.state).to.equal('blocked');
    expect(result.files).to.deep.equal([]);
    expect(result.providers).to.deep.equal([]);
    expect(calls).to.deep.equal([]);
  });

  for (const patch of [{ apiVersion: '66.0' }, { waitMinutes: 0 }, { waitMinutes: 31 }, { targetOrg: '--unsafe' }]) {
    it(`blocks invalid aggregate context ${JSON.stringify(patch)} before providers`, async () => {
      const result = await retrieveAll({ ...input, ...patch }, services);
      expect(result.state).to.equal('blocked');
      expect(result.providers).to.deep.equal([]);
      expect(calls).to.deep.equal([]);
    });
  }

  it('preserves read evidence for fresh Flow work after snapshot collision', async () => {
    await mkdir(join(input.projectRoot, 'mcnext'));
    await mkdir(join(input.projectRoot, 'mcnext', 'campaigns'));
    const sentinel = join(input.projectRoot, 'mcnext', 'campaigns', 'Exact Campaign.mcn-campaign.json');
    await writeFile(sentinel, 'existing');
    const result = await retrieveAll(input, services);
    expect(result.providers[0].state).to.equal('blocked');
    expect(result.providers.find((row) => row.family === `campaign-flows:${campaignId}`)?.state).to.equal('success');
    expect(await readFile(sentinel, 'utf8')).to.equal('existing');
    expect(result.files).to.have.length(1);
  });

  it('blocks Campaign-dependent selection on enumeration failure but continues independent identity', async () => {
    services.core = async () => ({ stdout: '', exitCode: 1 });
    const flows = sinon.stub().throws(new Error('must not call'));
    services.flows = flows;
    const result = await retrieveAll(input, services);
    expect(flows.called).to.equal(false);
    expect(result.providers[0].state).to.equal('failed');
    expect(result.providers.find((row) => row.family === 'identity-configuration')?.state).to.equal('success');
    expect(result.state).to.equal('partial');
  });

  it('retains actual pending job and stage under stronger terminal blocker reporting', async () => {
    services.flows = async () => ({
      campaignId,
      state: 'pending',
      members: ['ExactFlow'],
      files: [],
      associationPersistence: 'blocked',
      diagnostics: ['Still running'],
      jobId: '0Af000000000001AAA',
      stagingProject: 'retained-stage',
    });
    const result = await retrieveAll(input, services);
    const flow = result.providers.find((row) => row.family === `campaign-flows:${campaignId}`);
    expect(flow).to.include({ state: 'pending', jobId: '0Af000000000001AAA', stagingDirectory: 'retained-stage' });
    expect(result.state).to.equal('partial');
    expect(result.files).to.have.length(2);
  });

  it('forwards only the surviving Flow root after stage cleanup without exposing ownership', async () => {
    const root = await createRunOwnedDirectory(owner, 'retained-flow-root');
    const file = join(input.projectRoot, 'confirmed-flow.xml');
    await writeFile(file, 'closed Flow bytes');
    services.flows = async () => ({
      campaignId,
      state: 'succeeded',
      members: ['ExactFlow'],
      files: [{ member: 'ExactFlow', filePath: file }],
      associationPersistence: 'blocked',
      diagnostics: ['Native Flow cleanup warning'],
      retainedRoot: root,
    });
    const projected = projectRetrieveAllResult(await retrieveAll(input, services));
    const flow = projected.providers.find((row) => row.family === `campaign-flows:${campaignId}`)!;
    expect(flow).to.include({ state: 'success', retainedRoot: root });
    expect(flow.stagingDirectory).not.to.exist;
    expect((await lstat(flow.retainedRoot!)).isDirectory()).to.equal(true);
    expect(flow.files).to.deep.equal([file]);
    expect(await readFile(file, 'utf8')).to.equal('closed Flow bytes');
    for (const forbidden of ['stagingOwner', 'token', '"type":"Buffer"'])
      expect(JSON.stringify(projected)).not.to.include(forbidden);
  });

  it('isolates provider rejection without erasing earlier completed files', async () => {
    services.marketingCms = async () => {
      throw new Error('Dependency failed token=secret');
    };
    const result = await retrieveAll(input, services);
    expect(result.providers.find((row) => row.provider === 'sf-plugin-cms')?.state).to.equal('failed');
    expect(result.files).to.have.length(2);
    expect(JSON.stringify(result)).not.to.include('token=secret');
  });

  for (const secondFails of [false, true]) {
    it(`preserves actual-default per-Campaign discovery and file truth (second read fails: ${secondFails})`, async () => {
      const secondId = '701000000000002AAA';
      const reads: string[] = [];
      let nativeCalls = 0;
      const original = services.core!;
      const xml = Buffer.from(
        '<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><label>Original</label></Flow>\r\n'
      );
      services.core = async (args, cwd) => {
        if (args[0] === 'project') {
          nativeCalls++;
          expect(args).to.include('Flow:Shared');
          const filePath = join(cwd, 'native', 'main', 'default', 'flows', 'Shared.flow-meta.xml');
          await mkdir(join(filePath, '..'), { recursive: true });
          await writeFile(filePath, xml);
          return success({
            id: 'job-shared',
            done: true,
            success: true,
            status: 'Succeeded',
            files: [{ type: 'Flow', fullName: 'Shared', filePath, state: 'Created' }],
          });
        }
        const recordId = args[args.indexOf('--record-id') + 1];
        if (args.includes('--record-id')) {
          reads.push(recordId);
          if (secondFails && recordId === secondId) return { stdout: '', exitCode: 1 };
          return success({ Id: recordId, Name: recordId === campaignId ? 'First' : 'Second' });
        }
        if (args[0] === 'sobject') {
          const name = args[args.indexOf('--sobject') + 1];
          if (name === 'FlowDefinition' || name === 'Flow')
            return success({
              name,
              queryable: true,
              fields: (name === 'FlowDefinition'
                ? ['Id', 'DeveloperName', 'LatestVersionId', 'ActiveVersionId']
                : ['Id', 'DefinitionId', 'Metadata']
              ).map((field) => ({ name: field, type: 'string' })),
            });
        }
        const query = args[args.indexOf('--query') + 1];
        let records: unknown[] | undefined;
        if (query === 'SELECT Id FROM Campaign ORDER BY Id LIMIT 101') records = [{ Id: campaignId }, { Id: secondId }];
        else if (query?.includes('FROM FlowRecord'))
          records = [
            {
              Id: query.includes(secondId) ? '2aF000000000002AAA' : '2aF000000000001AAA',
              ApiName: 'Shared',
              AssociatedRecordId: query.includes(secondId) ? secondId : campaignId,
              SegmentId: null,
            },
          ];
        else if (query?.includes('FROM FlowDefinition'))
          records = [
            {
              Id: '300000000000001AAA',
              DeveloperName: 'Shared',
              LatestVersionId: '301000000000001AAA',
              ActiveVersionId: null,
            },
          ];
        else if (query?.includes('FROM Flow'))
          records = [
            {
              Id: '301000000000001AAA',
              DefinitionId: '300000000000001AAA',
              Metadata: { start: { triggerType: 'Schedule' } },
            },
          ];
        if (records) return success({ done: true, totalSize: records.length, records });
        return original(args, cwd);
      };
      const internal = await retrieveAll(input, services);
      expect(nativeCalls).to.equal(1);
      expect(reads.filter((id) => id === campaignId)).to.have.length(3);
      expect(reads.filter((id) => id === secondId)).to.have.length(secondFails ? 1 : 3);
      const path = join(input.projectRoot, 'native', 'main', 'default', 'flows', 'Shared.flow-meta.xml');
      expect(await readFile(path)).to.deep.equal(xml);
      const projected = projectRetrieveAllResult(internal);
      expect(projected.files.filter((file) => file === path)).to.deep.equal([path]);
      const second = projected.providers.find((row) => row.family === `campaign-flows:${secondId}`)!;
      expect(second.state).to.equal('blocked');
      expect(second.files).to.deep.equal([]);
      if (!secondFails) {
        expect(second.evidence?.members).to.deep.equal(['Shared']);
        expect(second.stagingDirectory).to.be.a('string');
        expect((await lstat(second.stagingDirectory!)).isDirectory()).to.equal(true);
        expect(second.diagnostics.join(' ')).to.include('Conflicting duplicate native Flow');
      }
      expect(
        projected.providers[0].evidence?.campaigns?.map((row) => ({
          campaignId: row.campaignId,
          state: row.state,
          files: row.files.length,
        }))
      ).to.deep.equal([
        { campaignId, state: 'success', files: 1 },
        { campaignId: secondId, state: secondFails ? 'failed' : 'success', files: secondFails ? 0 : 1 },
      ]);
      expect(projected.providers.find((row) => row.family === 'identity-configuration')?.state).to.equal('success');
      expect(projected.state).to.equal('partial');
    });
  }

  it('guards exact shared native members without bypassing fresh Flow discovery', async () => {
    const secondId = '701000000000002AAA';
    const snapshots = await (
      await import('../../src/registry/retrieveCampaigns.js')
    ).retrieveCampaignSnapshots(input, services.core);
    services.campaigns = async () => ({
      ...snapshots,
      campaigns: [snapshots.campaigns[0], { ...snapshots.campaigns[0], campaignId: secondId }],
    });
    const selected: string[] = [];
    services.flows = async (context, core) => {
      selected.push(context.campaignId);
      try {
        await core!(['project', 'retrieve', 'start', '--metadata', 'Flow:Shared'], context.projectRoot);
        return {
          campaignId: context.campaignId,
          state: 'succeeded',
          members: ['Shared'],
          files: [],
          associationPersistence: 'blocked',
          diagnostics: [],
        };
      } catch (error) {
        return {
          campaignId: context.campaignId,
          state: 'failed',
          members: ['Shared'],
          files: [],
          associationPersistence: 'blocked',
          diagnostics: [String(error)],
          stagingProject: 'retained-conflict-stage',
        };
      }
    };
    const result = await retrieveAll(input, services);
    expect(selected).to.deep.equal([campaignId, secondId]);
    expect(result.providers.find((row) => row.family === `campaign-flows:${secondId}`)).to.include({
      state: 'blocked',
      stagingDirectory: 'retained-conflict-stage',
    });
  });

  for (const mode of ['success', 'mixed', 'write-failure', 'root-cleanup-failure'] as const) {
    it(`projects actual default CMS ${mode} publication without historical stage or internal transport`, async () => {
      delete services.marketingCms;
      const cmsCalls: string[][] = [];
      const bytes = new Map<string, Buffer>();
      const exported = cloneFixture(mode === 'mixed' ? partialFailedExportFixture : validExportFixture);
      exported.metadata.plugin.version = '0.9.0';
      exported.provenance.pluginVersion = '0.9.0';
      exported.provenance.sourceOrgId = orgId;
      exported.result!.outputDirectory = 'cms';
      exported.result!.externalReferenceCorrelations = [];
      let stage = '';
      const producer = async (): Promise<void> => {
        if (mode === 'root-cleanup-failure')
          await writeFile(join(dirname(stage), 'unregistered-user-file'), 'do not delete');
        const row = exported.result!.workspaces[0];
        const raw = Buffer.from('{"apiName":"Page","contentKey":"original-key"}\r\n');
        const items = [
          {
            path: 'items/variant-one.json',
            kind: 'cms.content',
            sha256: createHash('sha256').update(raw).digest('hex'),
          },
        ];
        const manifest = Buffer.from(
          `${JSON.stringify({
            schemaVersion: 1,
            mode: 'experimental-best-effort',
            workspaceId: row.source.sourceId,
            search: {
              contentSpaceOrFolderIds: [row.source.sourceId],
              languages: ['All'],
              pageSize: 250,
              queryTerm: '*',
            },
            expectedCount: 1,
            foundCount: 1,
            exportedCount: 1,
            pagesRequested: 1,
            entries: [{ file: items[0].path, variantId: 'variant-one' }],
            rejectedVariantIds: [],
            failedVariantIds: [],
            warnings: [],
            contract: 'sf-cms-workspace-export',
            contractVersion: '1.0.0',
            provenance: {
              producer: 'sf-plugin-cms',
              sourceOrgId: orgId,
              sourceWorkspaceId: row.source.sourceId,
              pluginVersion: '0.9.0',
              generatedAt: exported.provenance.generatedAt,
            },
            completeness: 'complete',
            dependencies: [],
            externalReferences: [],
            items,
          })}\r\n`
        );
        row.artifact!.manifestSha256 = createHash('sha256').update(manifest).digest('hex');
        for (const [path, content] of [
          [items[0].path, raw],
          ['manifest.json', manifest],
        ] as const) {
          const destination = join(stage, row.artifact!.path, path);
          // eslint-disable-next-line no-await-in-loop -- complete public producer bytes before transport closes
          await mkdir(join(destination, '..'), { recursive: true });
          // eslint-disable-next-line no-await-in-loop -- exact binary package fixture
          await writeFile(destination, content);
          bytes.set(join(input.projectRoot, 'cms', row.artifact!.path, path), content);
        }
      };
      services.cms = {
        cli: {
          platform: 'linux',
          timeoutMs: 5000,
          spawn: ((executable, args, options) => {
            expect(executable).to.equal('sf');
            expect(options).to.include({ shell: false, windowsHide: true });
            cmsCalls.push(args as string[]);
            expect(cmsCalls.length).to.be.at.most(2);
            const child = new EventEmitter() as ChildProcess;
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            queueMicrotask(() => {
              void (async () => {
                if (cmsCalls.length === 2) {
                  stage = (args as string[])[9];
                  await producer();
                }
                child.stdout!.emit(
                  'data',
                  JSON.stringify(cmsCalls.length === 1 ? currentRegistryInfoFixture : exported)
                );
                child.emit('close', exported.status === 'partial' && cmsCalls.length === 2 ? 2 : 0, null);
              })().catch((error: unknown) => child.emit('error', error));
            });
            return child;
          }) as typeof spawn,
        },
      };
      if (mode === 'write-failure') {
        const original = filesystem.open;
        sinon.stub(filesystem, 'open').callsFake(async (...args: Parameters<typeof original>) => {
          if (String(args[0]).startsWith(join(input.projectRoot, 'cms')) && String(args[0]).endsWith('manifest.json'))
            throw new Error('CMS write failed token=private');
          return original(...args);
        });
      }
      const internal = await retrieveAll(input, services);
      const cms = internal.providers.find((row) => row.provider === 'sf-plugin-cms')!;
      const evidence = cms.result!;
      expect('retrieval' in evidence).to.equal(true);
      if (!('retrieval' in evidence)) throw new Error('Missing CMS evidence');
      expect(evidence.retrieval.stagingOwner).to.exist;
      expect(evidence.retrieval.stagingDirectory).to.equal(stage);
      expect(cmsCalls).to.deep.equal([CMS_REGISTRY_INFO_ARGS, buildCmsExportArgs(input.targetOrg, stage)]);
      const before = JSON.stringify(internal);
      const publicResult = projectRetrieveAllResult(internal);
      expect(JSON.stringify(internal)).to.equal(before);
      const publicCms = publicResult.providers.find((row) => row.provider === 'sf-plugin-cms')!;
      const completed = mode === 'success' || mode === 'root-cleanup-failure';
      expect(publicCms.state).to.equal(completed ? 'success' : 'partial');
      expect(publicCms.evidence?.cms?.workspaces[0].publication).to.equal(completed ? 'success' : 'partial');
      expect(publicCms.files).to.have.length(mode === 'write-failure' ? 1 : 2);
      for (const file of publicCms.files) {
        // eslint-disable-next-line no-await-in-loop -- verify all confirmed project bytes against real producer bytes
        expect(await readFile(file)).to.deep.equal(bytes.get(file));
      }
      if (completed) {
        expect(publicCms.stagingDirectory).not.to.exist;
        if (mode === 'root-cleanup-failure') {
          expect(publicCms.retainedRoot).to.equal(dirname(stage));
          expect((await lstat(publicCms.retainedRoot!)).isDirectory()).to.equal(true);
          expect(await readFile(join(publicCms.retainedRoot!, 'unregistered-user-file'), 'utf8')).to.equal(
            'do not delete'
          );
          expect(publicCms.diagnostics.join(' ')).to.include('CMS_PUBLICATION_CLEANUP_WARNING');
        } else {
          expect(publicCms.retainedRoot).not.to.exist;
          expect(evidence.publication.stagingOwner).not.to.exist;
        }
        let absent = false;
        try {
          await lstat(stage);
        } catch (error) {
          absent = (error as NodeJS.ErrnoException).code === 'ENOENT';
        }
        expect(absent).to.equal(true);
      } else {
        expect(publicCms.stagingDirectory).to.equal(stage);
        expect((await lstat(stage)).isDirectory()).to.equal(true);
      }
      if (mode === 'mixed') {
        expect(publicCms.evidence?.cms?.workspaces[1]).to.include({
          sourceStatus: 'failed',
          publication: 'not-attempted',
        });
        expect(publicCms.evidence?.cms?.workspaces[1].files).to.deep.equal([]);
        expect(publicCms.evidence?.cms?.workspaces[1].diagnostics[0]).to.include('WORKSPACE_EXPORT_FAILED');
      }
      const serialized = JSON.stringify(publicResult);
      for (const forbidden of ['stagingOwner', '"result":', '"type":"Buffer"', 'token=private'])
        expect(serialized).not.to.include(forbidden);
      expect(publicResult.complete).to.equal(false);
      expect(publicResult.files).to.include.members(publicCms.files);
    });
  }

  it('projects pending locators and identities but never raw Campaign/identity transport fields', async () => {
    services.createClient = async () =>
      ({
        apiVersion: '67.0',
        request: async () => ({
          identityResolutions: [{ rulesetId: '0Ii000000000001AAA', token: 'private-token' }],
          session: { accessToken: 'private-token', bytes: Buffer.from('private-bytes') },
        }),
      } as unknown as McnClient);
    services.flows = async () => ({
      campaignId,
      state: 'pending',
      members: ['ExactFlow'],
      files: [],
      associationPersistence: 'blocked',
      diagnostics: ['Bearer private-token'],
      jobId: 'job',
      stagingProject: 'current-stage',
    });
    const internal = await retrieveAll(input, services);
    const original = JSON.stringify(internal);
    const projected = projectRetrieveAllResult(internal);
    expect(JSON.stringify(internal)).to.equal(original);
    expect(original).to.include('private-token');
    expect(JSON.stringify(projected)).not.to.include('private-token');
    expect(JSON.stringify(projected)).not.to.include('private-bytes');
    expect(
      projected.providers.find((row) => row.family === 'identity-configuration')?.evidence?.rulesetIds
    ).to.deep.equal(['0Ii000000000001AAA']);
    expect(projected.providers.find((row) => row.family === `campaign-flows:${campaignId}`)).to.include({
      state: 'pending',
      jobId: 'job',
      stagingDirectory: 'current-stage',
    });
    expect(projected.providers[0].evidence?.campaigns?.[0]).to.include({ campaignId, state: 'success' });
  });

  it('counts fulfilled zero-row scopes as bounded work, never complete backup', async () => {
    services.campaigns = async () => ({ state: 'success', campaigns: [], files: [], diagnostics: [] });
    const flows = sinon.stub();
    services.flows = flows;
    const result = await retrieveAll(input, services);
    expect(flows.called).to.equal(false);
    expect(result.state).to.equal('partial');
    expect(result.complete).to.equal(false);
    expect(result.providers.some((row) => row.family === 'campaign-flows')).to.equal(false);
  });
});
