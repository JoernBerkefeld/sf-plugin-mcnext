import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'chai';
import { validateCmsExport } from '../../src/cms/contracts.js';
import { CmsPackageIntegrityError, validateCmsPackageEvidence } from '../../src/cms/packageIntegrity.js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
  type RunOwnedTemp,
} from '../../src/filesystem/runOwnedTemp.js';
import { cloneFixture, validExportFixture } from './contractFixtures.js';

type PackageCleanup = { run: RunOwnedTemp; root: string; consumed: boolean; links: string[] };
const packageRoots: PackageCleanup[] = [];

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

type PackageSetup = {
  cleanup: PackageCleanup;
  root: string;
  artifact: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  fixture: ReturnType<typeof cloneFixture<typeof validExportFixture>>;
};

async function createPackage(): Promise<PackageSetup> {
  const run = await createRunOwnedTemp('mcnext-cms-package');
  const root = await createRunOwnedDirectory(run, 'package');
  const cleanup: PackageCleanup = { run, root, consumed: false, links: [] };
  packageRoots.push(cleanup);
  const artifact = join(root, 'Marketing Workspace');
  await mkdir(join(artifact, 'nested'), { recursive: true });
  const itemBytes = Buffer.from('{"opaque":"payload-not-parsed"}\n');
  await writeFile(join(artifact, 'nested', 'item.json'), itemBytes);
  const fixture = cloneFixture(validExportFixture);
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    mode: 'experimental-best-effort',
    workspaceId: '0ZuSource',
    search: {},
    expectedCount: 1,
    foundCount: 1,
    exportedCount: 1,
    pagesRequested: 1,
    entries: [{ file: 'nested/item.json', variantId: 'variant-one' }],
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
    externalReferences: [
      {
        referenceId: 'ref:canonical-provider-identity',
        owner: 'cms',
        kind: 'cms.content',
        source: { workspaceId: '0ZuSource', sourceId: '20YSource' },
        portableKey: { scheme: 'cms-opaque-v1', value: ' OPAQUE:Case-Sensitive/Value== ' },
        required: true,
        resolution: 'included',
      },
    ],
    items: [{ path: 'nested/item.json', sha256: sha256(itemBytes), kind: 'cms.content' }],
  };
  const manifestPath = join(artifact, 'manifest.json');
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(manifestPath, manifestBytes);
  const manifestHash = sha256(manifestBytes);
  fixture.result!.workspaces[0].artifact.manifestSha256 = manifestHash;
  fixture.result!.externalReferenceCorrelations[0].packageManifestSha256 = manifestHash;
  return { cleanup, root, artifact, manifestPath, manifest, fixture };
}

async function rewriteManifest(setup: PackageSetup): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(setup.manifest)}\n`);
  await writeFile(setup.manifestPath, bytes);
  const hash = sha256(bytes);
  const fixture = setup.fixture;
  fixture.result!.workspaces[0].artifact.manifestSha256 = hash;
  fixture.result!.externalReferenceCorrelations[0].packageManifestSha256 = hash;
}

async function rejects(setup: PackageSetup, detail: string): Promise<void> {
  const envelope = validateCmsExport(setup.fixture);
  let error: unknown;
  try {
    await validateCmsPackageEvidence(setup.root, envelope, envelope.result!.workspaces[0]);
  } catch (caught) {
    error = caught;
  }
  expect(error).to.be.instanceOf(CmsPackageIntegrityError);
  expect((error as Error).message).to.include(detail);
}

describe('CMS package integrity evidence', () => {
  afterEach(async () => {
    await Promise.all(
      packageRoots.map(async (entry) => {
        const cleanup = entry;
        await Promise.all(cleanup.links.map(async (link) => unlink(link)));
        cleanup.links = [];
        if (!cleanup.consumed) {
          await removeRunOwnedPath(cleanup.run, cleanup.root);
          cleanup.consumed = true;
        }
        await removeRunOwnedRoot(cleanup.run);
      })
    );
    packageRoots.length = 0;
  });

  it('rejects absent failed-row artifacts before filesystem access', async () => {
    const fixture = cloneFixture(validExportFixture);
    const workspace = { ...fixture.result!.workspaces[0], status: 'failed' as const, artifact: null };
    let error: unknown;
    try {
      await validateCmsPackageEvidence('nonexistent-root', fixture, workspace);
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(CmsPackageIntegrityError);
    expect((error as Error).message).to.include('workspace artifact is unavailable');
  });

  it('verifies item bytes before exact manifest identity and binds opaque correlations', async () => {
    const setup = await createPackage();
    const envelope = validateCmsExport(setup.fixture);
    const evidence = await validateCmsPackageEvidence(setup.root, envelope, envelope.result!.workspaces[0]);
    expect(evidence.packageManifestSha256).to.equal(setup.fixture.result!.workspaces[0].artifact.manifestSha256);
    expect(evidence).to.include({
      sourceWorkspaceId: '0ZuSource',
      sourceOrgId: setup.fixture.provenance.sourceOrgId,
      pluginVersion: setup.fixture.provenance.pluginVersion,
      exportSetId: setup.fixture.provenance.exportSetId,
    });
    expect(evidence.correlations[0].sourceReference).to.equal(' OPAQUE:Case-Sensitive/Value== ');
  });

  for (const [field, value, detail] of [
    ['completeness', 'partial', 'completeness must be complete'],
    ['completeness', 'unknown', 'completeness must be complete'],
    ['expectedCount', 2, 'counts are inconsistent'],
    ['foundCount', -1, 'nonnegative integers'],
    ['exportedCount', '1', 'nonnegative integers'],
    ['entries', [], 'counts are inconsistent'],
    ['failedVariantIds', ['failed'], 'rejected or failed variants'],
    ['rejectedVariantIds', ['rejected'], 'rejected or failed variants'],
    ['warnings', [{ code: 'DETAIL_FAILED' }], 'unresolved warnings'],
  ] as const) {
    it(`rejects incomplete or contradictory manifest ${field}`, async () => {
      const setup = await createPackage();
      setup.manifest[field] = value;
      await rewriteManifest(setup);
      await rejects(setup, detail);
    });
  }

  it('rejects unsuccessful workspaces and applicable provider errors', async () => {
    const setup = await createPackage();
    const envelope = validateCmsExport(setup.fixture);
    for (const status of ['partial', 'failed', 'blocked'] as const) {
      const workspace = { ...setup.fixture.result!.workspaces[0], status };
      let caught: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop -- each status is independently rejected
        await validateCmsPackageEvidence(setup.root, envelope, workspace);
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).to.include('workspace export is not successful');
    }
    setup.fixture.diagnostics.errors.push({ code: 'EXPORT_ERROR', message: 'No reference field.' });
    await rejects(setup, 'unresolved errors');
  });

  it('ignores aggregate errors scoped to another workspace', async () => {
    const setup = await createPackage();
    setup.fixture.diagnostics.errors.push({
      code: 'WORKSPACE_EXPORT_FAILED',
      message: 'Another workspace was incomplete.',
      scope: '0ZuOther',
    });
    const envelope = validateCmsExport(setup.fixture);
    const evidence = await validateCmsPackageEvidence(setup.root, envelope, envelope.result!.workspaces[0]);
    expect(evidence.sourceWorkspaceId).to.equal('0ZuSource');
  });

  it('omits filesystem exception paths from missing-root diagnostics', async () => {
    const setup = await createPackage();
    await removeRunOwnedPath(setup.cleanup.run, setup.root);
    setup.cleanup.consumed = true;
    expect(setup.cleanup.consumed).to.equal(true);
    let missingRoot: unknown;
    try {
      await lstat(setup.root);
    } catch (error) {
      missingRoot = error;
    }
    expect((missingRoot as NodeJS.ErrnoException).code).to.equal('ENOENT');
    await rejects(setup, 'export root is unavailable');
  });

  it('rejects missing and extra regular files', async () => {
    const missing = await createPackage();
    await rm(join(missing.artifact, 'nested', 'item.json'));
    await rejects(missing, 'package regular-file set');

    const extra = await createPackage();
    await writeFile(join(extra.artifact, 'extra.txt'), 'extra');
    await rejects(extra, 'package regular-file set');
  });

  for (const [path, detail] of [
    ['nested/item.json', 'duplicate manifest item path'],
    ['../escape.json', 'contains traversal'],
    ['C:/escape.json', 'relative POSIX path'],
    ['nested\\item.json', 'relative POSIX path'],
  ] as const) {
    it(`rejects invalid listed path ${path}`, async () => {
      const setup = await createPackage();
      const items = setup.manifest.items as Array<Record<string, unknown>>;
      items.push({ ...items[0], path });
      await rewriteManifest(setup);
      await rejects(setup, detail);
    });
  }

  it('rejects non-exact manifest and item shapes', async () => {
    const extraTopLevel = await createPackage();
    extraTopLevel.manifest.extra = true;
    await rewriteManifest(extraTopLevel);
    await rejects(extraTopLevel, 'manifest fields must be exact');

    const missingKind = await createPackage();
    delete (missingKind.manifest.items as Array<Record<string, unknown>>)[0].kind;
    await rewriteManifest(missingKind);
    await rejects(missingKind, 'manifest item 0 fields must be exact');

    const extraItem = await createPackage();
    (extraItem.manifest.items as Array<Record<string, unknown>>)[0].payload = true;
    await rewriteManifest(extraItem);
    await rejects(extraItem, 'manifest item 0 fields must be exact');
  });

  it('rejects item substitution before accepting a manifest identity', async () => {
    const setup = await createPackage();
    await writeFile(join(setup.artifact, 'nested', 'item.json'), 'substituted');
    await rejects(setup, 'item hash mismatch');
  });

  it('rejects manifest hash mismatch only after item hashes pass', async () => {
    const setup = await createPackage();
    setup.fixture.result!.workspaces[0].artifact.manifestSha256 = 'f'.repeat(64);
    setup.fixture.result!.externalReferenceCorrelations[0].packageManifestSha256 = 'f'.repeat(64);
    await rejects(setup, 'manifest hash mismatch');
  });

  it('rejects symlink/reparse package entries and directories listed as files', async function () {
    const setup = await createPackage();
    const link = join(setup.artifact, 'linked.json');
    try {
      await symlink(join(setup.artifact, 'nested', 'item.json'), link, 'file');
      setup.cleanup.links.push(link);
    } catch {
      this.skip();
      return;
    }
    await rejects(setup, 'symlink or reparse entry');

    await unlink(link);
    setup.cleanup.links.splice(setup.cleanup.links.indexOf(link), 1);
    expect(await readFile(join(setup.artifact, 'nested', 'item.json'), 'utf8')).to.equal(
      '{"opaque":"payload-not-parsed"}\n'
    );
    await rm(join(setup.artifact, 'nested', 'item.json'));
    const items = setup.manifest.items as Array<Record<string, unknown>>;
    items[0].path = 'nested';
    await rewriteManifest(setup);
    await rejects(setup, 'package regular-file set');
  });

  it('rejects linked subtrees before cleanup and preserves the linked-target sentinel', async () => {
    const setup = await createPackage();
    const target = await createPackage();
    const sentinel = join(target.root, 'sentinel.txt');
    await writeFile(sentinel, 'linked-target-survives');
    const link = join(setup.artifact, 'linked-directory');
    await symlink(target.root, link, process.platform === 'win32' ? 'junction' : 'dir');
    setup.cleanup.links.push(link);
    await rejects(setup, 'symlink or reparse entry');
    let cleanupError: unknown;
    try {
      await removeRunOwnedPath(setup.cleanup.run, setup.root);
    } catch (error) {
      cleanupError = error;
    }
    expect(cleanupError).to.be.instanceOf(Error);
    expect((cleanupError as Error).message).to.match(/link|reparse/iu);
    expect(await readFile(sentinel, 'utf8')).to.equal('linked-target-survives');
    await unlink(link);
    setup.cleanup.links.splice(setup.cleanup.links.indexOf(link), 1);
    await removeRunOwnedPath(setup.cleanup.run, setup.root);
    setup.cleanup.consumed = true;
    expect(await readFile(sentinel, 'utf8')).to.equal('linked-target-survives');
  });

  it('rejects manifest provenance and source-workspace binding drift', async () => {
    const provenance = await createPackage();
    (provenance.manifest.provenance as Record<string, unknown>).sourceOrgId = 'wrong';
    await rewriteManifest(provenance);
    await rejects(provenance, 'source org binding');

    const workspace = await createPackage();
    workspace.manifest.workspaceId = 'wrong';
    await rewriteManifest(workspace);
    await rejects(workspace, 'source workspace binding');
  });

  it('rejects explicitly diagnosed unresolved correlation evidence', async () => {
    const setup = await createPackage();
    setup.fixture.result!.workspaces[0].diagnostics.errors.push({
      code: 'UNRESOLVED_REFERENCE',
      message: 'Reference was not correlated.',
      reference: 'unresolved',
    });
    await rejects(setup, 'unresolved correlation evidence');
  });

  it('rejects missing, extra, duplicate, partial, or conflicting manifest correlation bindings', async () => {
    const mutations = [
      (input: Record<string, unknown>): void => {
        const manifest = input;
        manifest.externalReferences = [];
      },
      (input: Record<string, unknown>): void => {
        const manifest = input;
        (manifest.externalReferences as unknown[]).push({
          referenceId: 'ref:extra',
          owner: 'cms',
          kind: 'cms.content',
          source: { workspaceId: '0ZuSource', sourceId: '20YExtra' },
          portableKey: { scheme: 'cms-opaque-v1', value: 'extra' },
          required: true,
          resolution: 'included',
        });
      },
      (input: Record<string, unknown>): void => {
        const manifest = input;
        (manifest.externalReferences as unknown[]).push(structuredClone((manifest.externalReferences as unknown[])[0]));
      },
      (input: Record<string, unknown>): void => {
        const manifest = input;
        delete (manifest.externalReferences as Array<Record<string, unknown>>)[0].referenceId;
      },
      (input: Record<string, unknown>): void => {
        const manifest = input;
        (manifest.externalReferences as Array<Record<string, unknown>>)[0].referenceId = 'ref:conflict';
      },
    ];
    await Promise.all(
      mutations.map(async (mutate) => {
        const setup = await createPackage();
        mutate(setup.manifest);
        await rewriteManifest(setup);
        await rejects(setup, 'external reference');
      })
    );
  });

  it('rejects wrong-package, duplicate, and conflicting correlation evidence', async () => {
    const wrongPackage = await createPackage();
    wrongPackage.fixture.result!.externalReferenceCorrelations[0].packageManifestSha256 = 'b'.repeat(64);
    expect(() => validateCmsExport(wrongPackage.fixture)).to.throw('correlation package binding');

    const duplicate = await createPackage();
    duplicate.fixture.result!.externalReferenceCorrelations.push({
      ...duplicate.fixture.result!.externalReferenceCorrelations[0],
    });
    expect(() => validateCmsExport(duplicate.fixture)).to.throw('correlation rows must be unique');

    const conflict = await createPackage();
    conflict.fixture.result!.externalReferenceCorrelations.push({
      ...conflict.fixture.result!.externalReferenceCorrelations[0],
      sourceReference: 'different',
    });
    expect(() => validateCmsExport(conflict.fixture)).to.throw('incompatible referenceId reuse');
  });

  it('enforces file/count/byte/traversal bounds', async () => {
    const assertBound = async (
      limits: Parameters<typeof validateCmsPackageEvidence>[3],
      detail: string
    ): Promise<void> => {
      const setup = await createPackage();
      const envelope = validateCmsExport(setup.fixture);
      let error: unknown;
      try {
        await validateCmsPackageEvidence(setup.root, envelope, envelope.result!.workspaces[0], limits);
      } catch (caught) {
        error = caught;
      }
      expect((error as Error).message).to.include(detail);
    };
    await Promise.all([
      assertBound({ maxFiles: 1 }, 'file count'),
      assertBound({ maxFileBytes: 1 }, 'item nested/item.json exceeds byte limit'),
      assertBound({ maxManifestBytes: 1 }, 'manifest exceeds byte limit'),
      assertBound({ maxTotalBytes: 1 }, 'total byte limit'),
      assertBound({ maxDepth: 0 }, 'positive integer'),
    ]);
  });
});
