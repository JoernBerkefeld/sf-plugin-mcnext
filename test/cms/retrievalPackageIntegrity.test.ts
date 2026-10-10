import { createHash } from 'node:crypto';
import filesystem, { appendFile, mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sinon from 'sinon';
import { expect } from 'chai';
import {
  validateCmsRetrievalPackage,
  validateCmsRetrievalPackageWithinBudget,
} from '../../src/cms/retrievalPackageIntegrity.js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
  type RunOwnedTemp,
} from '../../src/filesystem/runOwnedTemp.js';
import { cloneFixture, validExportFixture } from './contractFixtures.js';

type Metadata = Record<string, unknown>;
const hash = (bytes: Buffer | string, algorithm = 'sha256'): string =>
  createHash(algorithm).update(bytes).digest('hex');
const reports = [
  ['preferencePageReports', 'preference-page', 'preference-pages', 'preferencePage'],
  ['brandReports', 'brand', 'brands', 'brand'],
  ['formReports', 'form', 'forms', 'form'],
  ['formHandlerReports', 'form-handler', 'form-handlers', 'formHandler'],
  ['consentBannerReports', 'consent-banner', 'consent-banners', 'consentBanner'],
] as const;

describe('CMS retrieval package integrity', () => {
  let run: RunOwnedTemp;
  let root: string;
  let artifact: string;
  let fixture: typeof validExportFixture;
  let manifest: Metadata;
  let links: string[];
  let contents: Map<string, Buffer>;

  async function add(path: string, kind: string, value: Metadata | Buffer): Promise<void> {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value)}\n`);
    contents.set(path, bytes);
    (manifest.items as Metadata[]).push({ path, kind, sha256: hash(bytes) });
    const parts = path.split('/');
    parts.pop();
    await mkdir(join(artifact, ...parts), { recursive: true });
    await writeFile(join(artifact, path), bytes);
  }
  async function seal(): Promise<Buffer> {
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(artifact, 'manifest.json'), bytes);
    fixture.result!.workspaces[0].artifact.manifestSha256 = hash(bytes);
    for (const correlation of fixture.result!.externalReferenceCorrelations)
      correlation.packageManifestSha256 = hash(bytes);
    return bytes;
  }
  async function validate(
    versions: readonly string[] = ['1.0.0', '2.0.0']
  ): ReturnType<typeof validateCmsRetrievalPackage> {
    return validateCmsRetrievalPackage(root, fixture, fixture.result!.workspaces[0], versions);
  }
  async function rejects(detail: string): Promise<void> {
    let error: unknown;
    try {
      await validate();
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include(detail);
  }
  beforeEach(async () => {
    run = await createRunOwnedTemp('mcnext-retrieval-reader');
    root = await createRunOwnedDirectory(run, 'export');
    artifact = join(root, 'Marketing Workspace');
    await mkdir(artifact);
    fixture = cloneFixture(validExportFixture);
    fixture.result!.externalReferenceCorrelations = [];
    links = [];
    contents = new Map();
    manifest = {
      schemaVersion: 1,
      mode: 'experimental-best-effort',
      workspaceId: '0ZuSource',
      search: { contentSpaceOrFolderIds: ['0ZuSource'], languages: ['All'], pageSize: 250, queryTerm: '*' },
      expectedCount: 1,
      foundCount: 1,
      exportedCount: 1,
      pagesRequested: 1,
      entries: [{ file: 'items/variant-one.json', variantId: 'variant-one' }],
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [],
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: fixture.provenance.sourceOrgId,
        sourceWorkspaceId: '0ZuSource',
        pluginVersion: fixture.provenance.pluginVersion,
        generatedAt: fixture.provenance.generatedAt,
      },
      completeness: 'complete',
      dependencies: [],
      externalReferences: [],
      items: [],
    };
    await add('items/variant-one.json', 'cms.content', { apiName: 'Page', contentKey: 'page-key' });
    await seal();
  });
  afterEach(async () => {
    sinon.restore();
    for (const link of links) {
      // eslint-disable-next-line no-await-in-loop -- remove explicitly recorded fixture links before guarded cleanup
      await unlink(link);
    }
    await removeRunOwnedPath(run, root);
    await removeRunOwnedRoot(run);
  });

  it('retains original manifest and every declared companion byte without rewriting', async () => {
    await add('phase5/portable-metadata.v1.json', 'cms.portable-metadata', { opaque: 'retained' });
    await add('evidence/source.json', 'cms.source-admission', { opaque: 'provider evidence' });
    const original = await seal();
    const result = await validate();
    expect(result.artifactPath).to.equal('Marketing Workspace');
    expect(result.completeness).to.equal('complete');
    expect(result.files).to.have.length(4);
    expect(result.files.find((file) => file.path === 'manifest.json')!.bytes.equals(original)).to.equal(true);
    for (const [path, bytes] of contents)
      expect(result.files.find((file) => file.path === path)!.bytes.equals(bytes)).to.equal(true);
  });
  it('counts the manifest in the reservation before any package allocation or read', async () => {
    const original = await seal();
    const total = original.length + [...contents.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    const allocations = sinon.spy(Buffer, 'alloc');
    const opens = sinon.spy(filesystem, 'open');
    let error: unknown;
    try {
      await validateCmsRetrievalPackageWithinBudget(root, fixture, fixture.result!.workspaces[0], ['1.0.0'], total - 1);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.include('publication batch budget exceeded');
    expect(
      allocations
        .getCalls()
        .filter((call) =>
          [original.length, contents.get('items/variant-one.json')!.length].includes(Number(call.args[0]))
        )
    ).to.have.length(0);
    expect(opens.called).to.equal(false);
    const result = await validateCmsRetrievalPackageWithinBudget(
      root,
      fixture,
      fixture.result!.workspaces[0],
      ['1.0.0'],
      total
    );
    expect(result.files.reduce((sum, file) => sum + file.bytes.length, 0)).to.equal(total);
    expect(result.files[0].bytes).to.deep.equal(original);
  });
  for (const timing of ['before-open', 'during-read'] as const)
    it(`rejects growth ${timing} without allocating beyond the reserved source sizes`, async () => {
      const original = await seal();
      const raw = contents.get('items/variant-one.json')!;
      const total = original.length + raw.length;
      const allocations = sinon.spy(Buffer, 'alloc');
      const originalOpen = filesystem.open;
      const reads = sinon.spy();
      sinon.stub(filesystem, 'open').callsFake(async (...args: Parameters<typeof filesystem.open>) => {
        const target = String(args[0]);
        if (target.endsWith('variant-one.json') && timing === 'before-open') await appendFile(target, 'growth');
        const handle = await originalOpen(...args);
        if (target.endsWith('variant-one.json')) {
          const read = handle.read.bind(handle);
          sinon.stub(handle, 'read').callsFake(async (...readArgs: Parameters<typeof handle.read>) => {
            reads();
            await appendFile(target, 'growth');
            return read(...readArgs);
          });
        }
        return handle;
      });
      let error: unknown;
      try {
        await validateCmsRetrievalPackageWithinBudget(root, fixture, fixture.result!.workspaces[0], ['1.0.0'], total);
      } catch (caught) {
        error = caught;
      }
      expect((error as Error).message).to.include('source changed');
      expect(allocations.getCalls().filter((call) => call.args[0] === original.length)).to.have.length(1);
      expect(allocations.getCalls().filter((call) => call.args[0] === raw.length)).to.have.length(
        timing === 'before-open' ? 0 : 1
      );
      expect(allocations.getCalls().some((call) => call.args[0] === raw.length + 'growth'.length)).to.equal(false);
      expect(reads.callCount).to.equal(timing === 'before-open' ? 0 : 1);
    });
  for (const [field, family, directory, type] of reports)
    it(`binds ${family} reports without counting reports as raw exports`, async () => {
      const path = `reports/${directory}/variant-one.json`;
      const descriptor = {
        path,
        rawItemPath: 'items/variant-one.json',
        workspaceId: '0ZuSource',
        variantId: 'variant-one',
        apiName: 'Page',
        contentType: `sfdc_cms__${type}`,
        format: `sf-cms-${family}-read-report@1`,
      };
      manifest[field] = [descriptor];
      const { contentType, path: descriptorPath, ...identity } = descriptor;
      expect(contentType).to.include('sfdc_cms__');
      expect(descriptorPath).to.equal(path);
      await add(path, `cms.${family}.read-report`, {
        ...identity,
        normalization: { provenance: { contentSpaceId: '0ZuSource', managedContentVariantId: 'variant-one' } },
      });
      await seal();
      expect((await validate()).files).to.have.length(3);
      (manifest[field] as Metadata[])[0].rawItemPath = 'items/other.json';
      await seal();
      await rejects('report descriptor binding');
    });
  it('binds landing pairs by raw variants without inventing a companion file', async () => {
    await add('items/template.json', 'cms.content', { apiName: 'Template', contentKey: 'template-key' });
    (manifest.entries as Metadata[]).push({ file: 'items/template.json', variantId: 'template' });
    manifest.expectedCount = 2;
    manifest.foundCount = 2;
    manifest.exportedCount = 2;
    manifest.landingPageTemplatePairs = [
      {
        page: { apiName: 'Page', contentKey: 'page-key', variantId: 'variant-one' },
        template: {
          requestedTitle: 'Source Template',
          apiName: 'Template',
          contentKey: 'template-key',
          variantId: 'template',
        },
        compatibility: { basis: 'declared-source-pair', relationship: 'opaque-structural-match' },
      },
    ];
    await seal();
    expect((await validate()).files).to.have.length(3);
    (manifest.landingPageTemplatePairs as Array<{ page: Metadata }>)[0].page.contentKey = 'wrong';
    await seal();
    await rejects('landing pair payload binding');
  });
  it('accepts advertised embedded schema 2 under the real bulk wrapper version 1', async () => {
    manifest.schemaVersion = 2;
    manifest.contractVersion = '2.0.0';
    manifest.media = [];
    const media = Buffer.from('image bytes');
    const md5 = hash(media, 'md5');
    const url = `/cms/media/image?fileName=photo.png&fileHash=${md5}&version=3`;
    const raw = {
      apiName: 'Image',
      contentKey: 'image-key',
      contentType: 'sfdc_cms__image',
      status: { status: 'Draft' },
      lastModifiedDate: '2026-10-09',
      contentBody: { 'sfdc_cms:media': { url, source: { size: media.length, mimeType: 'image/png' } } },
    };
    (manifest.items as Metadata[]).shift();
    await add('items/variant-one.json', 'cms.content', raw);
    await add('media/variant-one-photo.png', 'cms.media', media);
    manifest.media = [
      {
        variantId: 'variant-one',
        contentKey: 'image-key',
        path: 'media/variant-one-photo.png',
        sha256: hash(media),
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
    await seal();
    const result = await validate();
    expect(result.completeness).to.equal('complete');
    expect(result.diagnostics.map((entry) => entry.code)).to.include('CMS_RETRIEVAL_MANIFEST_VERSION_DISCREPANCY');
    let error: unknown;
    try {
      await validate(['1.0.0']);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.include('unadvertised');
    (manifest.media as Metadata[])[0].bytes = 99;
    await seal();
    await rejects('media integrity binding');
  });
  it('retains legitimate partial raw/detail/media failures and provider diagnostics', async () => {
    manifest.schemaVersion = 2;
    manifest.contractVersion = '2.0.0';
    manifest.media = [];
    manifest.completeness = 'partial';
    manifest.expectedCount = 2;
    manifest.failedVariantIds = ['missing'];
    manifest.warnings = [{ code: 'MEDIA_EXPORT_FAILED', message: 'download unavailable', variantIds: ['variant-one'] }];
    fixture.status = 'partial';
    fixture.result!.workspaces[0].status = 'partial';
    fixture.result!.summary = { succeededCount: 0, partialCount: 1, failedCount: 0 };
    fixture.result!.workspaces[0].diagnostics.errors.push({ code: 'DETAIL_FAILED', message: 'missing detail' });
    await seal();
    const result = await validate();
    expect(result.completeness).to.equal('partial');
    expect(result.diagnostics[0].code).to.equal('DETAIL_FAILED');
    manifest.completeness = 'complete';
    await seal();
    await rejects('false complete');
  });
  it('binds included correlations while retaining unresolved references as partial', async () => {
    const row = {
      sourceWorkspaceId: '0ZuSource',
      sourceReference: 'Opaque/Case==',
      referenceKind: 'cms.content' as const,
      referenceId: `ref:${'a'.repeat(64)}`,
      packageManifestSha256: '',
    };
    fixture.result!.externalReferenceCorrelations = [row];
    manifest.externalReferences = [
      {
        referenceId: row.referenceId,
        owner: 'cms',
        kind: 'cms.content',
        source: { workspaceId: '0ZuSource', sourceId: 'content' },
        portableKey: { scheme: 'cms-opaque-v1', value: row.sourceReference },
        required: true,
        resolution: 'included',
      },
    ];
    await seal();
    expect((await validate()).completeness).to.equal('complete');
    (manifest.externalReferences as Metadata[])[0].resolution = 'unresolved';
    manifest.completeness = 'partial';
    fixture.result!.externalReferenceCorrelations = [];
    await seal();
    expect((await validate()).completeness).to.equal('partial');
    fixture.result!.externalReferenceCorrelations = [row];
    await seal();
    await rejects('included correlation bijection');
  });
  for (const path of [
    '../escape',
    '/absolute',
    'items/file:stream',
    'items/NUL.json',
    'items/COM¹.txt',
    'items/trailing.',
    'items/trailing ',
    'items/a?b',
    'items/a\u0001b',
    'items/ＡＵＸ.json',
    'items/a\\b',
  ])
    it(`rejects portable declaration ${JSON.stringify(path)}`, async () => {
      (manifest.items as Metadata[])[0].path = path;
      await seal();
      await rejects(path === '../escape' || path === '/absolute' || path === 'items/a\\b' ? 'path' : 'portable');
    });
  it('rejects invalid artifact and mismatched manifest paths', async () => {
    fixture.result!.workspaces[0].artifact.path = 'Workspace.';
    await rejects('portable');
    fixture.result!.workspaces[0].artifact.path = 'Marketing Workspace';
    fixture.result!.workspaces[0].artifact.manifestPath = 'other/manifest.json';
    await rejects('manifest path binding');
  });
  it('rejects missing, extra and tampered files and manifest bytes', async () => {
    await writeFile(join(artifact, 'extra'), 'extra');
    await rejects('regular-file set');
    await unlink(join(artifact, 'extra'));
    await writeFile(join(artifact, 'items/variant-one.json'), 'changed');
    await rejects('item hash mismatch');
    await unlink(join(artifact, 'items/variant-one.json'));
    await rejects('regular-file set');
    await writeFile(join(artifact, 'manifest.json'), '{}');
    await rejects('manifest hash mismatch');
  });
  it('rejects duplicate declarations, wrong source identity, unknown schema and orphan reports', async () => {
    (manifest.items as Metadata[]).push({ ...(manifest.items as Metadata[])[0] });
    await seal();
    await rejects('duplicate');
    (manifest.items as Metadata[]).pop();
    (manifest.provenance as Metadata).sourceOrgId = 'wrong';
    await seal();
    await rejects('provenance');
    (manifest.provenance as Metadata).sourceOrgId = fixture.provenance.sourceOrgId;
    manifest.schemaVersion = 3;
    await seal();
    await rejects('unsupported');
    manifest.schemaVersion = 1;
    await add('reports/orphan.json', 'cms.brand.read-report', {});
    await seal();
    await rejects('bijection');
  });
  it('rejects case aliases even on case-sensitive sources', async () => {
    (manifest.items as Metadata[]).push({
      path: 'ITEMS/variant-one.json',
      kind: 'cms.content',
      sha256: hash(contents.get('items/variant-one.json')!),
    });
    await seal();
    await rejects('declaration alias');
  });
  it('rejects NFKC declaration aliases and file ancestor conflicts', async () => {
    const item = (manifest.items as Metadata[])[0];
    (manifest.items as Metadata[]).push({ ...item, path: 'ｉtems/variant-one.json' });
    await seal();
    await rejects('declaration alias');
    (manifest.items as Metadata[]).pop();
    (manifest.items as Metadata[]).push({ ...item, path: 'items/variant-one.json/child' });
    await seal();
    await rejects('ancestor declaration conflict');
  });
  it('rejects excessive traversal depth and oversized control manifests', async () => {
    await mkdir(join(artifact, ...Array.from({ length: 33 }, () => 'deep')), { recursive: true });
    await rejects('traversal depth');
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 32);
    await writeFile(join(artifact, 'manifest.json'), bytes);
    fixture.result!.workspaces[0].artifact.manifestSha256 = hash(bytes);
    await rejects('byte limit');
  });
  it('rejects source junctions using only isolated owned fixtures', async function () {
    const link = join(artifact, 'linked');
    try {
      await symlink(join(artifact, 'items'), link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        this.skip();
        return;
      }
      throw error;
    }
    links.push(link);
    await rejects('reparse');
  });
  it('rejects oversized files without reading or allocating them', async () => {
    const bytes = Buffer.alloc(32 * 1024 * 1024 + 1);
    await writeFile(join(artifact, 'items/variant-one.json'), bytes);
    (manifest.items as Metadata[])[0].sha256 = hash(bytes);
    await seal();
    await rejects('byte limit');
  });
});
