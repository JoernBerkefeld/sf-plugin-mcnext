import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import filesystem from 'node:fs/promises';
import { mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import sinon from 'sinon';
import type { Org } from '@salesforce/core';
import { expect } from 'chai';
import { CMS_REGISTRY_INFO_ARGS, buildCmsExportArgs } from '../../src/cms/cmsCli.js';
import type { CmsEnvelope, CmsExportResult } from '../../src/cms/contracts.js';
import { createRunOwnedDirectory, createRunOwnedTemp, type RunOwnedTemp } from '../../src/filesystem/runOwnedTemp.js';
import {
  publishMarketingCms,
  retrieveAndPublishMarketingCms,
  retrieveMarketingCms,
  validateRetrievalProject,
  type MarketingCmsRetrievalInput,
} from '../../src/registry/retrieve-resolver.js';
import {
  blockedExportFixture,
  cloneFixture,
  currentRegistryInfoFixture,
  failedExportFixture,
  partialFailedExportFixture,
  validExportFixture,
} from '../cms/contractFixtures.js';

type Wire = {
  value: unknown;
  code?: number;
  stderr?: string;
  hang?: boolean;
  spawnError?: boolean;
  produce?: (stage: string, envelope: CmsEnvelope<CmsExportResult>) => Promise<void>;
};

describe('retained Marketing CMS provider', () => {
  let project: string;
  let fixtureOwner: RunOwnedTemp;
  let input: MarketingCmsRetrievalInput;
  let calls: string[][];
  let orgCalls: string[];
  const native = Buffer.from('native Flow\r\nunchanged\0');
  const configuration = '{"packageDirectories":[{"path":"force-app","default":true}],"sourceApiVersion":"67.0"}\n';

  before(async () => {
    fixtureOwner = await createRunOwnedTemp('mcnext-cms-provider-test');
    project = await createRunOwnedDirectory(fixtureOwner, 'project');
    await mkdir(join(project, 'force-app'));
    await writeFile(join(project, 'force-app', 'sentinel.flow-meta.xml'), native);
    await writeFile(join(project, 'sfdx-project.json'), configuration);
  });
  beforeEach(() => {
    input = { projectRoot: project, targetOrg: 'fresh-alias', expectedOrgId: '00DSource', apiVersion: '67.0' };
    calls = [];
    orgCalls = [];
  });
  afterEach(async () => {
    expect(await readFile(join(project, 'sfdx-project.json'), 'utf8')).to.equal(configuration);
    expect(await readFile(join(project, 'force-app', 'sentinel.flow-meta.xml'))).to.deep.equal(native);
    expect((await readdir(project)).sort()).to.deep.equal(['force-app', 'sfdx-project.json']);
  });
  // Retain all isolated fixtures and returned stages: the provider never performs automatic cleanup.

  describe('aggregate-only project validation', () => {
    let destination: string;
    beforeEach(async () => {
      destination = await createRunOwnedDirectory(
        fixtureOwner,
        `aggregate-${createHash('sha256').update(String(Math.random())).digest('hex')}`
      );
      await mkdir(join(destination, 'force-app'));
      await mkdir(join(destination, 'second'));
      await writeFile(join(destination, 'force-app', 'sentinel'), native);
    });
    async function configure(entries: unknown[]): Promise<void> {
      await writeFile(join(destination, 'sfdx-project.json'), JSON.stringify({ packageDirectories: entries }));
    }
    async function rejectsWithoutWrites(root = destination, configurationName = 'sfdx-project.json'): Promise<void> {
      const configurationBefore = await readFile(join(destination, configurationName));
      const entriesBefore = await readdir(destination);
      let failure: unknown;
      try {
        await validateRetrievalProject(root);
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
      expect(await readFile(join(destination, configurationName))).to.deep.equal(configurationBefore);
      expect(await readdir(destination)).to.deep.equal(entriesBefore);
      expect(await readFile(join(destination, 'force-app', 'sentinel'))).to.deep.equal(native);
      expect(calls).to.deep.equal([]);
      expect(orgCalls).to.deep.equal([]);
    }
    it('returns every canonical native root in configuration order without creating output trees', async () => {
      await configure([{ path: 'second' }, { path: 'force-app', default: true }]);
      expect(await validateRetrievalProject(destination)).to.deep.equal([
        join(destination, 'second'),
        join(destination, 'force-app'),
      ]);
      expect((await readdir(destination)).sort()).to.deep.equal(['force-app', 'second', 'sfdx-project.json']);
      await mkdir(join(destination, 'data'));
      await writeFile(join(destination, 'data', 'sentinel'), 'existing output preserved');
      expect(await validateRetrievalProject(destination)).to.have.length(2);
      expect(await readFile(join(destination, 'data', 'sentinel'), 'utf8')).to.equal('existing output preserved');
    });
    for (const defaults of [
      [false, false],
      [true, true],
      ['true', false],
    ])
      it(`rejects invalid default selection ${JSON.stringify(defaults)}`, async () => {
        await configure([
          { path: 'force-app', default: defaults[0] },
          { path: 'second', default: defaults[1] },
        ]);
        await rejectsWithoutWrites();
      });
    for (const path of [
      'force-app',
      'force-app/child',
      'FORCE-APP',
      'ｆorce-app',
      'missing',
      '../escape',
      'second/../force-app',
      'NUL.json',
      'COM¹.txt',
      'second:stream',
      'second.',
      'second ',
      'bad\u0001root',
      'second\\..\\force-app',
    ])
      it(`rejects invalid, duplicate or overlapping native root ${JSON.stringify(path)}`, async () => {
        await mkdir(join(destination, 'force-app', 'child'));
        await configure([{ path: 'force-app', default: true }, { path }]);
        await rejectsWithoutWrites();
      });
    for (const name of ['cms', 'data', 'mcnext']) {
      for (const path of [name, `${name}/native`])
        it(`rejects existing native/output overlap ${path}`, async () => {
          await mkdir(join(destination, path), { recursive: true });
          await configure([{ path: 'force-app', default: true }, { path }]);
          await rejectsWithoutWrites();
        });
      for (const alias of [
        name.toUpperCase(),
        [...name].map((char) => String.fromCharCode(char.charCodeAt(0) + 0xfe_e0)).join(''),
      ])
        it(`rejects output root alias ${alias}`, async () => {
          await mkdir(join(destination, alias));
          await writeFile(join(destination, alias, 'sentinel'), 'unchanged');
          await configure([{ path: 'force-app', default: true }]);
          await rejectsWithoutWrites();
          expect(await readFile(join(destination, alias, 'sentinel'), 'utf8')).to.equal('unchanged');
        });
      it(`rejects a non-directory output root ${name}`, async () => {
        await writeFile(join(destination, name), 'unchanged');
        await configure([{ path: 'force-app', default: true }]);
        await rejectsWithoutWrites();
        expect(await readFile(join(destination, name), 'utf8')).to.equal('unchanged');
      });
    }
    for (const target of ['project', 'configuration', 'native', 'cms', 'data', 'mcnext'])
      it(`rejects linked/reparse ${target} without touching the target`, async () => {
        await configure([{ path: 'force-app', default: true }]);
        const linked = join(destination, 'linked');
        if (target === 'configuration') {
          await writeFile(join(destination, 'original.json'), await readFile(join(destination, 'sfdx-project.json')));
          await filesystem.unlink(join(destination, 'sfdx-project.json'));
          await symlink(
            process.platform === 'win32' ? join(destination, 'force-app') : join(destination, 'original.json'),
            join(destination, 'sfdx-project.json'),
            process.platform === 'win32' ? 'junction' : 'file'
          );
        } else {
          await symlink(
            join(destination, 'force-app'),
            target === 'project' || target === 'native' ? linked : join(destination, target),
            process.platform === 'win32' ? 'junction' : 'dir'
          );
          if (target === 'native') await configure([{ path: 'force-app', default: true }, { path: 'linked' }]);
        }
        await rejectsWithoutWrites(
          target === 'project' ? linked : destination,
          target === 'configuration' ? 'original.json' : 'sfdx-project.json'
        );
      });
  });

  function spawner(wires: Wire[]): typeof spawn {
    return ((executable: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      expect(executable).to.equal('sf');
      expect(options).to.include({ shell: false, windowsHide: true });
      calls.push(args);
      const wire = wires[calls.length - 1];
      if (!wire) throw new Error('Unexpected extra CMS subprocess');
      if (wire.spawnError) throw new Error('token=private spawn failure');
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (() => {
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      }) as ChildProcess['kill'];
      if (!wire.hang)
        queueMicrotask(() => {
          void (async () => {
            const value = cloneFixture(wire.value);
            if (calls.length === 2 && value && typeof value === 'object' && 'contract' in value) {
              const envelope = value as CmsEnvelope<CmsExportResult>;
              if (envelope.result) {
                if (wire.produce) await wire.produce(args[9], envelope);
                else await writeFile(join(args[9], 'provider-bytes.bin'), Buffer.from('CMS\r\nopaque\0'));
              }
            }
            child.stdout!.emit('data', JSON.stringify(value));
            child.stderr!.emit('data', wire.stderr ?? '');
            child.emit('close', wire.code ?? 0, null);
          })().catch((error: unknown) => child.emit('error', error));
        });
      return child;
    }) as typeof spawn;
  }
  function exported(fixture = validExportFixture as CmsEnvelope<CmsExportResult>): CmsEnvelope<CmsExportResult> {
    const value = cloneFixture(fixture);
    value.metadata.plugin.version = '0.9.0';
    value.provenance.pluginVersion = '0.9.0';
    if (value.result) value.result.outputDirectory = 'cms';
    return value;
  }
  function run(wires: Wire[], orgId = '00DSource') {
    return retrieveMarketingCms(input, {
      createOrg: async (alias) => {
        orgCalls.push(alias);
        return { getOrgId: () => orgId } as Org;
      },
      cli: { platform: 'linux', spawn: spawner(wires), timeoutMs: 5000 },
    });
  }
  const discovery = (): Wire => ({ value: cloneFixture(currentRegistryInfoFixture) });

  describe('durable publication', () => {
    let bytes: Map<string, Buffer>;
    let destination: string;
    beforeEach(async () => {
      destination = await createRunOwnedDirectory(
        fixtureOwner,
        `publish-${createHash('sha256').update(String(Math.random())).digest('hex')}`
      );
      await mkdir(join(destination, 'force-app'));
      await mkdir(join(destination, 'second'));
      await writeFile(
        join(destination, 'sfdx-project.json'),
        '{"packageDirectories":[{"path":"force-app"},{"path":"second"}]}'
      );
      input.projectRoot = destination;
      bytes = new Map();
    });
    afterEach(() => sinon.restore());
    async function produce(stage: string, envelope: CmsEnvelope<CmsExportResult>): Promise<void> {
      for (const row of envelope.result!.workspaces) {
        if (!row.artifact || !['success', 'partial'].includes(row.status)) continue;
        const raw = Buffer.from('{"apiName":"Page","contentKey":"page-key"}\r\n');
        const evidence = Buffer.from('opaque provider evidence\r\n\0');
        const items = [
          {
            path: 'items/variant-one.json',
            kind: 'cms.content',
            sha256: createHash('sha256').update(raw).digest('hex'),
          },
          {
            path: 'evidence/source.bin',
            kind: 'cms.source-admission',
            sha256: createHash('sha256').update(evidence).digest('hex'),
          },
        ];
        const manifest = Buffer.from(
          `${JSON.stringify(
            {
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
                sourceOrgId: envelope.provenance.sourceOrgId,
                sourceWorkspaceId: row.source.sourceId,
                pluginVersion: envelope.provenance.pluginVersion,
                generatedAt: envelope.provenance.generatedAt,
              },
              completeness: row.status === 'partial' ? 'partial' : 'complete',
              dependencies: [],
              externalReferences: [],
              items,
            },
            null,
            2
          )}\r\n`
        );
        row.artifact.manifestSha256 = createHash('sha256').update(manifest).digest('hex');
        for (const [path, content] of [
          [items[0].path, raw],
          [items[1].path, evidence],
          ['manifest.json', manifest],
        ] as const) {
          const full = join(stage, row.artifact.path, path);
          // eslint-disable-next-line no-await-in-loop -- fixture producer writes source bytes before subprocess completion
          await mkdir(join(full, '..'), { recursive: true });
          // eslint-disable-next-line no-await-in-loop -- preserve fixture's original binary bytes
          await writeFile(full, content);
          bytes.set(join(destination, 'cms', row.artifact.path, path), content);
        }
      }
      const exportResult = envelope.result!;
      exportResult.externalReferenceCorrelations = [];
    }
    async function staged(value = exported()) {
      return run([
        discovery(),
        { value, code: value.status === 'partial' ? 2 : value.status === 'failed' ? 1 : 0, produce },
      ]);
    }
    it('composes exactly one public export and preserves every original byte, cleaning only owned staging', async () => {
      const configurationBefore = await readFile(join(destination, 'sfdx-project.json'));
      const entriesBefore = await readdir(destination);
      let aggregateError: unknown;
      try {
        await validateRetrievalProject(destination);
      } catch (error) {
        aggregateError = error;
      }
      expect(aggregateError).to.be.instanceOf(Error);
      expect((aggregateError as Error).message).to.include('exactly one default');
      expect(await readFile(join(destination, 'sfdx-project.json'))).to.deep.equal(configurationBefore);
      expect(await readdir(destination)).to.deep.equal(entriesBefore);
      expect(calls).to.deep.equal([]);
      expect(orgCalls).to.deep.equal([]);
      const result = await retrieveAndPublishMarketingCms(input, {
        createOrg: async () => ({ getOrgId: () => '00DSource' } as Org),
        cli: { platform: 'linux', spawn: spawner([discovery(), { value: exported(), produce }]), timeoutMs: 5000 },
      });
      expect(calls).to.have.length(2);
      expect(calls[1]).to.deep.equal(buildCmsExportArgs(input.targetOrg, result.retrieval.stagingDirectory!));
      expect(result.publication.publication).to.equal('success');
      expect(result.retrieval.publication).to.equal('not-attempted');
      expect(result.publication.files).to.have.length(3);
      expect(result.publication.files.at(-1)).to.match(/manifest\.json$/u);
      for (const [path, content] of bytes) {
        // eslint-disable-next-line no-await-in-loop -- exact destination-byte assertion for every public file
        expect(await readFile(path)).to.deep.equal(content);
      }
      expect(result.publication.stagingOwner).not.to.exist;
      expect(result.publication.stagingDirectory).not.to.exist;
    });
    it('preserves partial and failed-null public rows without upgrading copied packages', async () => {
      const retrieval = await staged(exported(partialFailedExportFixture));
      const result = await publishMarketingCms(input, retrieval);
      expect(result.publication).to.equal('partial');
      expect(result.workspaces).to.have.length(2);
      expect(result.workspaces[0].publication).to.equal('partial');
      expect(result.workspaces[1].sourceStatus).to.equal('failed');
      expect(result.workspaces[1].files).to.deep.equal([]);
      expect(result.stagingDirectory).to.equal(retrieval.stagingDirectory);
    });
    it('cleans genuine zero-selection success without inventing an output package', async () => {
      const value = exported();
      value.result!.workspaces = [];
      value.result!.externalReferenceCorrelations = [];
      value.result!.selection = { mode: 'all', discoveredCount: 0, selectedCount: 0 };
      value.result!.summary = { succeededCount: 0, partialCount: 0, failedCount: 0 };
      const retrieval = await staged(value);
      const result = await publishMarketingCms(input, retrieval);
      expect(result.publication).to.equal('success');
      expect(result.files).to.deep.equal([]);
      expect(result.stagingOwner).not.to.exist;
      expect(await readdir(destination)).not.to.include('cms');
    });
    it('publishes a genuine partial Image schema-2 package under the unchanged bulk wrapper-1', async () => {
      const value = exported();
      value.status = 'partial';
      value.result!.workspaces[0].status = 'partial';
      value.result!.summary = { succeededCount: 0, partialCount: 1, failedCount: 0 };
      const imageProducer = async (stage: string, envelope: CmsEnvelope<CmsExportResult>): Promise<void> => {
        await produce(stage, envelope);
        const row = envelope.result!.workspaces[0];
        const path = join(stage, row.artifact!.path, 'manifest.json');
        const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        manifest.schemaVersion = 2;
        manifest.contractVersion = '2.0.0';
        manifest.media = [];
        manifest.warnings = [
          { code: 'MEDIA_EXPORT_FAILED', message: 'download unavailable', variantIds: ['variant-one'] },
        ];
        const rawPath = join(stage, row.artifact!.path, 'items/variant-one.json');
        const raw = Buffer.from(
          JSON.stringify({
            apiName: 'Image',
            contentKey: 'image-key',
            contentType: 'sfdc_cms__image',
            status: { status: 'Draft' },
            lastModifiedDate: '2026-10-09',
            contentBody: {
              'sfdc_cms:media': {
                url: '/cms/media/image?fileName=photo.png&fileHash=00000000000000000000000000000000&version=3',
                source: { size: 11, mimeType: 'image/png' },
              },
            },
          })
        );
        await writeFile(rawPath, raw);
        (manifest.items as Array<{ sha256: string }>)[0].sha256 = createHash('sha256').update(raw).digest('hex');
        const original = Buffer.from(`${JSON.stringify(manifest, null, 2)}\r\n`);
        await writeFile(path, original);
        row.artifact!.manifestSha256 = createHash('sha256').update(original).digest('hex');
        bytes.set(join(destination, 'cms', row.artifact!.path, 'items/variant-one.json'), raw);
        bytes.set(join(destination, 'cms', row.artifact!.path, 'manifest.json'), original);
      };
      const retrieval = await run([discovery(), { value, code: 2, produce: imageProducer }]);
      const result = await publishMarketingCms(input, retrieval);
      expect(result.publication).to.equal('partial');
      expect(result.diagnostics.map((entry) => entry.code)).to.include('CMS_RETRIEVAL_MANIFEST_VERSION_DISCREPANCY');
      expect(retrieval.exportEnvelope!.result!.workspaces[0].artifact!.manifestContractVersion).to.equal('1.0.0');
      for (const [path, content] of bytes) {
        // eslint-disable-next-line no-await-in-loop -- preserve original schema2 partial package bytes
        expect(await readFile(path)).to.deep.equal(content);
      }
      expect(result.files).to.have.length(3);
      expect(result.stagingDirectory).to.equal(retrieval.stagingDirectory);
    });
    it('preserves actual Image media bytes and its schema2 manifest without a restore claim', async () => {
      const mediaProducer = async (stage: string, envelope: CmsEnvelope<CmsExportResult>): Promise<void> => {
        await produce(stage, envelope);
        const row = envelope.result!.workspaces[0];
        const path = join(stage, row.artifact!.path, 'manifest.json');
        const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        const media = Buffer.from([0, 255, 13, 10, 7]);
        const md5 = createHash('md5').update(media).digest('hex');
        const sha256 = createHash('sha256').update(media).digest('hex');
        const url = `/cms/media/image?fileName=photo.png&fileHash=${md5}&version=3`;
        const raw = Buffer.from(
          JSON.stringify({
            apiName: 'Image',
            contentKey: 'image-key',
            contentType: 'sfdc_cms__image',
            status: { status: 'Draft' },
            lastModifiedDate: '2026-10-09',
            contentBody: { 'sfdc_cms:media': { url, source: { size: media.length, mimeType: 'image/png' } } },
          })
        );
        manifest.schemaVersion = 2;
        manifest.contractVersion = '2.0.0';
        const items = manifest.items as Array<{ path: string; kind: string; sha256: string }>;
        items[0].sha256 = createHash('sha256').update(raw).digest('hex');
        items.push({ path: 'media/variant-one-photo.png', kind: 'cms.media', sha256 });
        manifest.media = [
          {
            variantId: 'variant-one',
            contentKey: 'image-key',
            path: 'media/variant-one-photo.png',
            sha256,
            md5,
            bytes: media.length,
            mimeType: 'image/png',
            fileName: 'photo.png',
            sourceStatus: 'Draft',
            sourceModifiedAt: '2026-10-09',
            sourceVersion: '3',
            sourceUrl: url,
            transport: 'experimental-undocumented-authoring-media',
          },
        ];
        await mkdir(join(stage, row.artifact!.path, 'media'));
        await writeFile(join(stage, row.artifact!.path, items[0].path), raw);
        await writeFile(join(stage, row.artifact!.path, items[2].path), media);
        const original = Buffer.from(`${JSON.stringify(manifest, null, 2)}\r\n`);
        await writeFile(path, original);
        row.artifact!.manifestSha256 = createHash('sha256').update(original).digest('hex');
        bytes.set(join(destination, 'cms', row.artifact!.path, items[0].path), raw);
        bytes.set(join(destination, 'cms', row.artifact!.path, items[2].path), media);
        bytes.set(join(destination, 'cms', row.artifact!.path, 'manifest.json'), original);
      };
      const retrieval = await run([discovery(), { value: exported(), produce: mediaProducer }]);
      const result = await publishMarketingCms(input, retrieval);
      expect(result.publication).to.equal('success');
      expect(result.files).to.have.length(4);
      for (const [path, content] of bytes) {
        // eslint-disable-next-line no-await-in-loop -- assert every verified original media/raw/manifest byte
        expect(await readFile(path)).to.deep.equal(content);
      }
    });
    it('publishes the original report bytes and manifest after binding the raw item', async () => {
      const reportProducer = async (stage: string, envelope: CmsEnvelope<CmsExportResult>): Promise<void> => {
        await produce(stage, envelope);
        const row = envelope.result!.workspaces[0];
        const path = join(stage, row.artifact!.path, 'manifest.json');
        const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        const reportPath = 'reports/brands/variant-one.json';
        const identity = {
          rawItemPath: 'items/variant-one.json',
          workspaceId: row.source.sourceId,
          variantId: 'variant-one',
          apiName: 'Page',
          format: 'sf-cms-brand-read-report@1',
        };
        const report = Buffer.from(
          `${JSON.stringify({
            ...identity,
            normalization: {
              provenance: { contentSpaceId: row.source.sourceId, managedContentVariantId: 'variant-one' },
            },
            opaque: 'provider report retained unchanged',
          })}\r\n`
        );
        manifest.brandReports = [{ ...identity, path: reportPath, contentType: 'sfdc_cms__brand' }];
        (manifest.items as Array<{ path: string; kind: string; sha256: string }>).push({
          path: reportPath,
          kind: 'cms.brand.read-report',
          sha256: createHash('sha256').update(report).digest('hex'),
        });
        await mkdir(join(stage, row.artifact!.path, 'reports', 'brands'), { recursive: true });
        await writeFile(join(stage, row.artifact!.path, reportPath), report);
        const original = Buffer.from(`${JSON.stringify(manifest, null, 2)}\r\n`);
        await writeFile(path, original);
        row.artifact!.manifestSha256 = createHash('sha256').update(original).digest('hex');
        bytes.set(join(destination, 'cms', row.artifact!.path, reportPath), report);
        bytes.set(join(destination, 'cms', row.artifact!.path, 'manifest.json'), original);
      };
      const result = await retrieveAndPublishMarketingCms(input, {
        createOrg: async () => ({ getOrgId: () => '00DSource' } as Org),
        cli: { platform: 'linux', spawn: spawner([discovery(), { value: exported(), produce: reportProducer }]) },
      });
      expect(result.publication.publication).to.equal('success');
      expect(result.publication.files).to.have.length(4);
      expect(result.publication.files.at(-1)).to.match(/manifest\.json$/u);
      for (const [path, content] of bytes) {
        // eslint-disable-next-line no-await-in-loop -- exact original raw/report/evidence/manifest publication bytes
        expect(await readFile(path)).to.deep.equal(content);
      }
    });
    it('rejects an invalid later source candidate before any project directory or file write', async () => {
      const value = exported();
      const sibling = cloneFixture(value.result!.workspaces[0]);
      sibling.source.sourceId = '0ZuSourceZ';
      sibling.artifact!.path = 'Second';
      sibling.artifact!.manifestPath = 'Second/manifest.json';
      value.result!.workspaces.push(sibling);
      value.result!.selection = { mode: 'all', discoveredCount: 2, selectedCount: 2 };
      value.result!.summary.succeededCount = 2;
      const retrieval = await staged(value);
      await writeFile(join(retrieval.stagingDirectory!, 'Second', 'items/variant-one.json'), 'later tampering');
      const result = await publishMarketingCms(input, retrieval);
      expect(result.publication).to.equal('blocked');
      expect(result.files).to.deep.equal([]);
      expect(result.workspaces.map((row) => row.publication)).to.deep.equal(['blocked', 'blocked']);
      expect(result.stagingDirectory).to.equal(retrieval.stagingDirectory);
      expect((await readdir(destination)).sort()).to.deep.equal(['force-app', 'second', 'sfdx-project.json']);
    });
    for (const [first, artifact] of [
      ['Marketing Workspace', 'Ｍarketing Workspace/Child'],
      ['Group/First', 'group/Second'],
      ['Group/First', 'Ｇroup/Second'],
    ])
      it(`blocks cross-candidate ancestor conflict ${artifact} before project writes`, async () => {
        const value = exported();
        value.result!.workspaces[0].artifact!.path = first;
        value.result!.workspaces[0].artifact!.manifestPath = `${first}/manifest.json`;
        const sibling = cloneFixture(value.result!.workspaces[0]);
        sibling.source.sourceId = '0ZuSourceZ';
        sibling.artifact!.path = artifact;
        sibling.artifact!.manifestPath = `${artifact}/manifest.json`;
        value.result!.workspaces.push(sibling);
        value.result!.selection = { mode: 'all', discoveredCount: 2, selectedCount: 2 };
        value.result!.summary.succeededCount = 2;
        // Distinct source trees remain valid; only their normalized destination ancestors conflict.
        const retrieval = await staged(value);
        const result = await publishMarketingCms(input, retrieval);
        expect(result.publication).to.equal('blocked');
        expect(result.diagnostics.at(-1)!.message).to.match(/workspace (?:ancestor alias|destinations overlap)/u);
        expect(result.files).to.deep.equal([]);
        expect(result.stagingDirectory).to.equal(retrieval.stagingDirectory);
        expect(await readdir(destination)).not.to.include('cms');
      });
    it('blocks individually valid packages exceeding the whole-batch byte budget before writes', async () => {
      const value = exported();
      const sibling = cloneFixture(value.result!.workspaces[0]);
      sibling.source.sourceId = '0ZuSourceZ';
      sibling.artifact!.path = 'Second';
      sibling.artifact!.manifestPath = 'Second/manifest.json';
      value.result!.workspaces.push(sibling);
      value.result!.selection = { mode: 'all', discoveredCount: 2, selectedCount: 2 };
      value.result!.summary.succeededCount = 2;
      const payload = Buffer.alloc(28 * 1024 * 1024, 7);
      const sha256 = createHash('sha256').update(payload).digest('hex');
      const budgetProducer = async (stage: string, envelope: CmsEnvelope<CmsExportResult>): Promise<void> => {
        await produce(stage, envelope);
        for (const row of envelope.result!.workspaces) {
          const path = join(stage, row.artifact!.path, 'manifest.json');
          // eslint-disable-next-line no-await-in-loop -- construct two individually bounded real packages
          const manifest = JSON.parse(await readFile(path, 'utf8')) as {
            items: Array<{ path: string; kind: string; sha256: string }>;
          };
          for (let index = 0; index < 5; index++) {
            const item = { path: `evidence/budget-${index}.bin`, kind: 'cms.source-admission', sha256 };
            manifest.items.push(item);
            // eslint-disable-next-line no-await-in-loop -- reuse a bounded buffer for original fixture bytes
            await writeFile(join(stage, row.artifact!.path, item.path), payload);
          }
          const original = Buffer.from(JSON.stringify(manifest));
          // eslint-disable-next-line no-await-in-loop -- bind the original manifest to the public row
          await writeFile(path, original);
          row.artifact!.manifestSha256 = createHash('sha256').update(original).digest('hex');
        }
      };
      const retrieval = await run([discovery(), { value, produce: budgetProducer }]);
      const allocations = sinon.spy(Buffer, 'alloc');
      const opens = sinon.spy(filesystem, 'open');
      const result = await publishMarketingCms(input, retrieval);
      expect(allocations.getCalls().filter((call) => call.args[0] === payload.length)).to.have.length(5);
      expect(
        opens.getCalls().filter((call) => String(call.args[0]).startsWith(join(retrieval.stagingDirectory!, 'Second')))
      ).to.have.length(0);
      expect(result.publication).to.equal('blocked');
      expect(result.diagnostics.at(-1)!.message).to.include('publication batch budget exceeded');
      expect(result.files).to.deep.equal([]);
      expect(result.stagingDirectory).to.equal(retrieval.stagingDirectory);
      expect(await readdir(destination)).not.to.include('cms');
    });
    it('does not publish all-failed or valid blocked-null evidence', async () => {
      const retrieval = await staged(exported(failedExportFixture));
      expect((await publishMarketingCms(input, retrieval)).publication).to.equal('not-attempted');
      const value = exported(blockedExportFixture);
      value.metadata.apiVersion = null;
      const blocked = await run([discovery(), { value, code: 1 }]);
      expect((await publishMarketingCms(input, blocked)).publication).to.equal('not-attempted');
      expect(await readdir(destination)).not.to.include('cms');
    });
    for (const mutation of ['forged', 'stage', 'owner', 'envelope', 'context'] as const)
      it(`blocks ${mutation} evidence before any writes`, async () => {
        const retrieval = await staged();
        if (mutation === 'stage') retrieval.stagingDirectory = destination;
        if (mutation === 'owner') retrieval.stagingOwner = { root: retrieval.stagingOwner!.root };
        if (mutation === 'envelope') retrieval.exportEnvelope!.provenance.sourceOrgId = 'wrong';
        if (mutation === 'context') input.targetOrg = 'different';
        const result = await publishMarketingCms(input, mutation === 'forged' ? { ...retrieval } : retrieval);
        expect(result.publication).to.equal('blocked');
        expect(result.files).to.deep.equal([]);
        expect(await readdir(destination)).not.to.include('cms');
      });
    for (const nativeRoot of [
      'cms',
      'cms/native',
      'NUL.json',
      'force-app:stream',
      'Workspace.',
      'bad\u0001root',
      'missing',
    ])
      it(`blocks changed native root ${JSON.stringify(nativeRoot)} with zero writes`, async () => {
        const retrieval = await staged();
        await writeFile(
          join(destination, 'sfdx-project.json'),
          JSON.stringify({ packageDirectories: [{ path: nativeRoot }] })
        );
        const result = await publishMarketingCms(input, retrieval);
        expect(result.publication).to.equal('blocked');
        expect(result.files).to.deep.equal([]);
        expect(await readdir(destination)).not.to.include('cms');
      });
    for (const configuredRoot of ['cms', 'cms/native'])
      it(`rejects actual existing native overlap ${configuredRoot}`, async () => {
        const retrieval = await staged();
        await mkdir(join(destination, 'cms'));
        if (configuredRoot.endsWith('/native')) await mkdir(join(destination, 'cms', 'native'));
        await writeFile(join(destination, configuredRoot, 'sentinel'), 'native unchanged');
        await writeFile(
          join(destination, 'sfdx-project.json'),
          JSON.stringify({ packageDirectories: [{ path: configuredRoot }] })
        );
        const result = await publishMarketingCms(input, retrieval);
        expect(result.publication).to.equal('blocked');
        expect(result.files).to.deep.equal([]);
        expect(await readFile(join(destination, configuredRoot, 'sentinel'), 'utf8')).to.equal('native unchanged');
      });
    it('preflights all candidates before publishing and preserves an existing collision sentinel', async () => {
      const value = exported();
      const sibling = cloneFixture(value.result!.workspaces[0]);
      sibling.source.sourceId = '0ZuSourceZ';
      sibling.artifact!.path = 'Second';
      sibling.artifact!.manifestPath = 'Second/manifest.json';
      value.result!.workspaces.push(sibling);
      value.result!.selection = { mode: 'all', discoveredCount: 2, selectedCount: 2 };
      value.result!.summary.succeededCount = 2;
      const retrieval = await staged(value);
      await mkdir(join(destination, 'cms'));
      await writeFile(join(destination, 'cms', 'Second'), 'sentinel');
      const result = await publishMarketingCms(input, retrieval);
      expect(result.publication).to.equal('blocked');
      expect(await readdir(join(destination, 'cms'))).to.deep.equal(['Second']);
      expect(await readFile(join(destination, 'cms', 'Second'), 'utf8')).to.equal('sentinel');
    });
    for (const invalid of [
      'items/file:stream',
      'items/NUL.json',
      'items/COM¹.txt',
      'items/trailing.',
      'items/a\u0001b',
    ])
      it(`rejects invalid provider declaration ${JSON.stringify(invalid)} before writes`, async () => {
        const invalidProducer = async (stage: string, envelope: CmsEnvelope<CmsExportResult>): Promise<void> => {
          await produce(stage, envelope);
          const row = envelope.result!.workspaces[0];
          const path = join(stage, row.artifact!.path, 'manifest.json');
          const manifest = JSON.parse(await readFile(path, 'utf8')) as { items: Array<{ path: string }> };
          manifest.items[0].path = invalid;
          const original = Buffer.from(JSON.stringify(manifest));
          await writeFile(path, original);
          row.artifact!.manifestSha256 = createHash('sha256').update(original).digest('hex');
        };
        const retrieval = await run([discovery(), { value: exported(), produce: invalidProducer }]);
        const result = await publishMarketingCms(input, retrieval);
        expect(result.publication).to.equal('blocked');
        expect(result.files).to.deep.equal([]);
        expect(await readdir(destination)).not.to.include('cms');
      });
    for (const artifact of ['Work:stream', 'NUL.json', 'Workspace.', 'bad\u0001name'])
      it(`rejects invalid provider artifact ${JSON.stringify(artifact)} before writes`, async () => {
        const value = exported();
        value.result!.workspaces[0].artifact!.path = artifact;
        value.result!.workspaces[0].artifact!.manifestPath = `${artifact}/manifest.json`;
        const retrieval = await run([discovery(), { value }]);
        expect((await publishMarketingCms(input, retrieval)).files).to.deep.equal([]);
        expect(await readdir(destination)).not.to.include('cms');
      });
    it('rejects case aliases and linked cms parents without touching user sentinel bytes', async () => {
      const retrieval = await staged();
      const outside = await createRunOwnedDirectory(
        fixtureOwner,
        `outside-${createHash('sha256').update(String(Math.random())).digest('hex')}`
      );
      await writeFile(join(outside, 'sentinel'), 'unchanged');
      await symlink(outside, join(destination, 'cms'), process.platform === 'win32' ? 'junction' : 'dir');
      expect((await publishMarketingCms(input, retrieval)).publication).to.equal('blocked');
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).to.equal('unchanged');
    });
    for (const alias of ['CMS', 'ｃｍｓ'])
      it(`rejects the alias-only output root ${alias} without adding the canonical cms root`, async () => {
        const retrieval = await staged();
        await mkdir(join(destination, alias));
        await writeFile(join(destination, alias, 'sentinel'), 'unchanged');
        const result = await publishMarketingCms(input, retrieval);
        expect(result.publication).to.equal('blocked');
        expect(result.files).to.deep.equal([]);
        expect(await readFile(join(destination, alias, 'sentinel'), 'utf8')).to.equal('unchanged');
        expect(await readdir(destination))
          .to.include(alias)
          .and.not.include('cms');
      });
    it('rejects a configured native-root junction introduced after retrieval', async () => {
      const retrieval = await staged();
      const outside = await createRunOwnedDirectory(
        fixtureOwner,
        `native-outside-${createHash('sha256').update(String(Math.random())).digest('hex')}`
      );
      await writeFile(join(outside, 'sentinel'), 'native unchanged');
      await symlink(outside, join(destination, 'linked-native'), process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(
        join(destination, 'sfdx-project.json'),
        JSON.stringify({ packageDirectories: [{ path: 'force-app' }, { path: 'linked-native' }] })
      );
      const result = await publishMarketingCms(input, retrieval);
      expect(result.publication).to.equal('blocked');
      expect(result.files).to.deep.equal([]);
      expect(await readdir(destination)).not.to.include('cms');
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).to.equal('native unchanged');
    });
    it('keeps durable success and actual owner-root location after guarded cleanup refusal', async () => {
      const retrieval = await staged();
      await writeFile(join(retrieval.stagingOwner!.root, 'unregistered-user-file'), 'do not delete');
      const result = await publishMarketingCms(input, retrieval);
      expect(result.publication).to.equal('success');
      expect(result.files).to.have.length(3);
      expect(result.stagingDirectory).not.to.exist;
      expect(result.stagingOwner).to.equal(retrieval.stagingOwner);
      expect(result.diagnostics.map((entry) => entry.code)).to.include('CMS_PUBLICATION_CLEANUP_WARNING');
      expect(await readFile(join(retrieval.stagingOwner!.root, 'unregistered-user-file'), 'utf8')).to.equal(
        'do not delete'
      );
    });
    it('rejects existing case-normalized workspace collisions without touching the sentinel', async () => {
      const retrieval = await staged();
      await mkdir(join(destination, 'cms'));
      await mkdir(join(destination, 'cms', 'marketing workspace'));
      await writeFile(join(destination, 'cms', 'marketing workspace', 'sentinel'), 'unchanged');
      const result = await publishMarketingCms(input, retrieval);
      expect(result.publication).to.equal('blocked');
      expect(result.files).to.deep.equal([]);
      expect(await readdir(join(destination, 'cms', 'marketing workspace'))).to.deep.equal(['sentinel']);
    });
    it('blocks corrupted source packages without making the cms directory', async () => {
      const retrieval = await staged();
      await writeFile(
        join(
          retrieval.stagingDirectory!,
          retrieval.exportEnvelope!.result!.workspaces[0].artifact!.path,
          'items/variant-one.json'
        ),
        'tampered'
      );
      expect((await publishMarketingCms(input, retrieval)).publication).to.equal('blocked');
      expect(await readdir(destination)).not.to.include('cms');
    });
    for (const failure of ['writeFile', 'close'] as const)
      it(`excludes the attempted file after ${failure} failure and retains successful earlier bytes`, async () => {
        const retrieval = await staged();
        const original = filesystem.open;
        sinon.stub(filesystem, 'open').callsFake(async (...args: Parameters<typeof filesystem.open>) => {
          const handle = await original(...args);
          if (String(args[0]).endsWith('variant-one.json') && args[1] === 'wx') {
            if (failure === 'writeFile') sinon.stub(handle, 'writeFile').rejects(new Error('injected write failure'));
            else {
              const close = handle.close.bind(handle);
              sinon.stub(handle, 'close').callsFake(async () => {
                await close();
                throw new Error('injected close failure');
              });
            }
          }
          return handle;
        });
        const result = await publishMarketingCms(input, retrieval);
        expect(result.publication).to.equal('partial');
        expect(result.files).to.have.length(1);
        expect(result.files[0]).to.match(/source\.bin$/u);
        expect(result.workspaces[0].files).to.deep.equal(result.files);
        expect(result.workspaces[0].publication).to.equal('partial');
        expect(result.stagingDirectory).to.equal(retrieval.stagingDirectory);
        expect(result.diagnostics.at(-1)!.scope).to.include('variant-one.json');
        expect(await readdir(join(destination, 'cms', 'Marketing Workspace'))).not.to.include('manifest.json');
        expect(await readFile(result.files[0])).to.deep.equal(bytes.get(result.files[0]));
      });
    it('reports only successfully closed files and retains staging after an exclusive-open race', async () => {
      const retrieval = await staged();
      const original = filesystem.open;
      const stub = sinon.stub(filesystem, 'open').callsFake(async (...args: Parameters<typeof filesystem.open>) => {
        if (String(args[0]).endsWith('variant-one.json') && args[1] === 'wx') {
          await writeFile(args[0], 'raced user bytes');
        }
        return original(...args);
      });
      const result = await publishMarketingCms(input, retrieval);
      stub.restore();
      expect(result.publication).to.equal('partial');
      expect(result.files).to.have.length(1);
      expect(result.files[0]).to.match(/source\.bin$/u);
      expect(result.files.some((path) => path.endsWith('manifest.json'))).to.equal(false);
      expect(result.stagingDirectory).to.equal(retrieval.stagingDirectory);
      expect(
        await readFile(join(destination, 'cms', 'Marketing Workspace', 'items/variant-one.json'), 'utf8')
      ).to.equal('raced user bytes');
    });
  });

  it('delegates exactly v2 then public Marketing bulk, retaining bytes and genuine ownership', async () => {
    const info = discovery();
    const result = await run([info, { value: exported() }]);
    expect(result.state).to.equal('success');
    expect(result.exportEnvelope!.result!.outputDirectory).to.equal('cms');
    expect(result.exportEnvelope!.result!.outputDirectory).not.to.equal(result.stagingDirectory);
    expect(result.publication).to.equal('not-attempted');
    expect(orgCalls).to.deep.equal(['fresh-alias']);
    expect(calls).to.deep.equal([
      [...CMS_REGISTRY_INFO_ARGS],
      buildCmsExportArgs(input.targetOrg, result.stagingDirectory!),
    ]);
    expect(calls.flat()).not.to.include('--api-version');
    expect(result.registry).to.deep.equal(currentRegistryInfoFixture.result.registry);
    expect(result.stagingOwner).to.exist;
    expect(Object.isFrozen(result.stagingOwner)).to.equal(true);
    expect(await realpath(result.stagingDirectory!)).to.equal(result.stagingDirectory);
    expect(relative(project, result.stagingDirectory!)).to.match(/^\.\./);
    expect(await readFile(join(result.stagingOwner!.root, '.sf-mcnext-run-owner.json'), 'utf8')).to.include('runId');
    expect(await readFile(join(result.stagingDirectory!, 'provider-bytes.bin'))).to.deep.equal(
      Buffer.from('CMS\r\nopaque\0')
    );
    expect(result.exportEnvelope!.result!.externalReferenceCorrelations).to.deep.equal(
      validExportFixture.result!.externalReferenceCorrelations
    );
  });

  it('retains honest zero Marketing success without manufacturing inventory', async () => {
    const value = exported();
    value.result!.workspaces = [];
    value.result!.externalReferenceCorrelations = [];
    value.result!.selection = { mode: 'all', discoveredCount: 0, selectedCount: 0 };
    value.result!.summary = { succeededCount: 0, partialCount: 0, failedCount: 0 };
    const result = await run([discovery(), { value }]);
    expect(result.state).to.equal('success');
    expect(result.exportEnvelope!.result!.workspaces).to.deep.equal([]);
    expect(result.stagingDirectory).to.exist;
  });

  it('preserves the full mixed Marketing bulk inventory rather than narrow registry filtering', async () => {
    const info = discovery();
    (info.value as typeof currentRegistryInfoFixture).result.registry.declarations = [
      cloneFixture(currentRegistryInfoFixture.result.registry.declarations[0]),
    ];
    const value = exported();
    const sibling = cloneFixture(value.result!.workspaces[0]);
    sibling.source = {
      kind: 'cms.workspace',
      sourceId: '0ZuSourceZ',
      name: 'Content-named Marketing',
      workspaceType: 'Marketing',
    };
    sibling.artifact!.path = 'Other';
    sibling.artifact!.manifestPath = 'Other/manifest.json';
    value.result!.workspaces.push(sibling);
    value.result!.selection = { mode: 'all', discoveredCount: 3, selectedCount: 2 };
    value.result!.summary.succeededCount = 2;
    const result = await run([info, { value }]);
    expect(result.state).to.equal('success');
    expect(result.exportEnvelope!.result!.workspaces).to.deep.equal(value.result!.workspaces);
  });

  for (const [fixture, code] of [
    [partialFailedExportFixture, 2],
    [failedExportFixture, 1],
  ] as const) {
    it(`preserves ${fixture.status} evidence and failed-null rows`, async () => {
      const result = await run([discovery(), { value: exported(fixture), code }]);
      expect(result.state).to.equal(fixture.status);
      expect(result.exportEnvelope!.result!.outputDirectory).to.equal('cms');
      expect(result.exportEnvelope!.result!.workspaces).to.deep.equal(fixture.result!.workspaces);
      expect(result.diagnostics).to.deep.equal([...fixture.diagnostics.warnings, ...fixture.diagnostics.errors]);
      expect(result.stagingOwner).to.exist;
    });
  }
  it('retains validated unresolved-org blocked/null evidence without claiming org proof', async () => {
    const value = exported(blockedExportFixture);
    value.metadata.apiVersion = null;
    const result = await run([discovery(), { value, code: 1 }]);
    expect(result.state).to.equal('blocked');
    expect(result.exportEnvelope).to.deep.equal(value);
    expect(result.exportEnvelope!.provenance).not.to.have.property('exportSetId');
    expect(result.exportEnvelope!.provenance.sourceOrgId).to.equal('unresolved-org');
    expect(result.diagnostics).to.deep.equal(value.diagnostics.errors);
    expect(result.stagingOwner).to.exist;
  });

  for (const mismatch of ['org', 'api', 'plugin', 'output'] as const) {
    it(`blocks non-null ${mismatch} binding mismatch with stage retained`, async () => {
      const value = exported();
      if (mismatch === 'org') value.provenance.sourceOrgId = '00DWrong';
      if (mismatch === 'api') value.metadata.apiVersion = '66.0';
      if (mismatch === 'plugin') {
        value.metadata.plugin.version = '0.9.1';
        value.provenance.pluginVersion = '0.9.1';
      }
      if (mismatch === 'output') value.result!.outputDirectory = 'wrong-label';
      const result = await run([discovery(), { value }]);
      expect(result.state).to.equal('blocked');
      expect(result.exportEnvelope).not.to.exist;
      expect(result.stagingOwner).to.exist;
    });
  }

  for (const field of ['api', 'plugin'] as const) {
    it(`checks available ${field} binding even on blocked/null evidence`, async () => {
      const value = exported(blockedExportFixture);
      if (field === 'api') value.metadata.apiVersion = '66.0';
      else {
        value.metadata.plugin.version = '0.9.1';
        value.provenance.pluginVersion = '0.9.1';
      }
      const result = await run([discovery(), { value, code: 1 }]);
      expect(result.state).to.equal('blocked');
      expect(result.exportEnvelope).not.to.exist;
      expect(result.stagingDirectory).to.exist;
    });
  }

  for (const reason of ['capability', 'export-contract', 'default-api', 'tested-api', 'v2'] as const) {
    it(`does not export after unsupported ${reason} negotiation`, async () => {
      const info = discovery();
      const value = info.value as typeof currentRegistryInfoFixture;
      if (reason === 'capability')
        value.result.capabilities = value.result.capabilities.filter((item) => item.id !== 'workspace.export.bulk');
      if (reason === 'export-contract') value.result.contracts.commandResults.workspaceExportSet = ['2.0.0'];
      if (reason === 'default-api') value.result.api.defaultVersion = '66.0';
      if (reason === 'tested-api') value.result.api.testedVersions = ['66.0'];
      if (reason === 'v2') value.contractVersion = '1.0.0';
      const result = await run([info]);
      expect(result.state).to.equal('blocked');
      expect(calls).to.have.length(1);
      expect(result.stagingDirectory).not.to.exist;
    });
  }
  it('does not require import capability for retrieval', async () => {
    const info = discovery();
    (info.value as typeof currentRegistryInfoFixture).result.capabilities =
      currentRegistryInfoFixture.result.capabilities.filter((item) => item.id !== 'workspace.import.mapping');
    expect((await run([info, { value: exported() }])).state).to.equal('success');
  });
  it('blocks fresh org mismatch and non-default requested API before export', async () => {
    expect((await run([], '00DWrong')).state).to.equal('blocked');
    expect(calls).to.have.length(0);
    input.apiVersion = '68.0';
    expect((await run([discovery()])).state).to.equal('blocked');
    expect(calls).to.have.length(1);
  });
  it('rejects malformed project and linked project configuration before delegation', async () => {
    const malformed = await createRunOwnedDirectory(fixtureOwner, 'malformed');
    await writeFile(join(malformed, 'sfdx-project.json'), '{"packageDirectories":[{"path":"../escape"}]}');
    input.projectRoot = malformed;
    expect((await run([])).state).to.equal('blocked');
    const linked = join(fixtureOwner.root, 'linked');
    await symlink(project, linked, process.platform === 'win32' ? 'junction' : 'dir');
    input.projectRoot = linked;
    expect((await run([])).state).to.equal('blocked');
    expect(calls).to.have.length(0);
  });

  for (const message of [
    'Workspace classification is missing.',
    'Workspace enumeration made no progress.',
    'Workspace enumeration exceeded page bound.',
  ]) {
    it(`rejects actual outer preflight wire: ${message}`, async () => {
      const outer = {
        status: 1,
        name: 'Error',
        message,
        exitCode: 1,
        actions: [],
        context: 'ExportWorkspace',
        stack: 'Error',
        warnings: [],
      };
      const result = await run([discovery(), { value: outer, code: 1 }]);
      expect(result.state).to.equal('failed');
      expect(result.exportEnvelope).not.to.exist;
      expect(result.stagingOwner).to.exist;
      expect(result.diagnostics[0].message).to.include('envelope fields');
      expect(calls).to.have.length(2);
    });
  }
  for (const invalid of ['path', 'classification', 'counts'] as const) {
    it(`fails closed for malformed ${invalid} evidence`, async () => {
      const value = exported();
      if (invalid === 'path') value.result!.workspaces[0].artifact!.path = '../escape';
      if (invalid === 'classification') Object.assign(value.result!.workspaces[0].source, { workspaceType: 'Content' });
      if (invalid === 'counts') value.result!.summary.succeededCount = 9;
      const result = await run([discovery(), { value }]);
      expect(result.state).to.equal('failed');
      expect(result.exportEnvelope).not.to.exist;
      expect(result.stagingDirectory).to.exist;
    });
  }
  for (const version of ['result', 'manifest'] as const) {
    it(`blocks unadvertised ${version} version despite compatible major`, async () => {
      const value = exported();
      if (version === 'result') value.contractVersion = '1.1.0';
      else value.result!.workspaces[0].artifact!.manifestContractVersion = '1.1.0';
      const result = await run([discovery(), { value }]);
      expect(result.state).to.equal('blocked');
      expect(result.exportEnvelope).not.to.exist;
      expect(result.stagingOwner).to.exist;
    });
  }
  for (const mode of ['spawn', 'timeout'] as const) {
    it(`retains stage and bounded redacted adapter diagnostics on ${mode} failure`, async () => {
      const result = await retrieveMarketingCms(input, {
        createOrg: async () => ({ getOrgId: () => '00DSource' } as Org),
        cli: {
          platform: 'linux',
          timeoutMs: 20,
          spawn: spawner([discovery(), { value: null, spawnError: mode === 'spawn', hang: mode === 'timeout' }]),
        },
      });
      expect(result.state).to.equal('failed');
      expect(result.stagingOwner).to.exist;
      expect(result.exportEnvelope).not.to.exist;
      expect(result.diagnostics[0].message).not.to.include('token=private');
      expect(result.diagnostics[0].message.length).to.be.at.most(2048);
    });
  }
});
