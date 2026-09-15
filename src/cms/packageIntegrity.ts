import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  CMS_PLUGIN_NAME,
  type CmsEnvelope,
  type CmsExportResult,
  type CmsExportWorkspace,
  type CmsExternalReferenceCorrelation,
} from './contracts.js';

const CONTROL_FILE = 'manifest.json';
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 32;

export type CmsPackageIntegrityLimits = {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  maxManifestBytes?: number;
  maxDepth?: number;
};

export type ValidatedCmsPackage = {
  sourceWorkspaceId: string;
  artifactPath: string;
  manifestPath: string;
  packageManifestSha256: string;
  sourceOrgId: string;
  pluginVersion: string;
  exportSetId: string;
  correlations: CmsExternalReferenceCorrelation[];
};

type ManifestItem = { path: string; sha256: string; kind: string; referenceId?: string };
type PackageManifest = {
  contract: string;
  contractVersion: string;
  workspaceId: string;
  provenance: {
    producer: string;
    sourceOrgId: string;
    sourceWorkspaceId: string;
    pluginVersion: string;
  };
  exportedCount: number;
  items: ManifestItem[];
};

const MANIFEST_FIELDS = [
  'schemaVersion',
  'mode',
  'workspaceId',
  'search',
  'expectedCount',
  'foundCount',
  'exportedCount',
  'pagesRequested',
  'entries',
  'rejectedVariantIds',
  'failedVariantIds',
  'warnings',
  'contract',
  'contractVersion',
  'provenance',
  'completeness',
  'dependencies',
  'externalReferences',
  'items',
] as const;
const MANIFEST_PROVENANCE_FIELDS = [
  'producer',
  'sourceOrgId',
  'sourceWorkspaceId',
  'pluginVersion',
  'generatedAt',
] as const;

export class CmsPackageIntegrityError extends Error {}

/** Validate one exported CMS workspace package without interpreting item payloads. */
// eslint-disable-next-line complexity -- integrity checks intentionally fail closed at one package boundary
export async function validateCmsPackageEvidence(
  exportRoot: string,
  envelope: CmsEnvelope<CmsExportResult>,
  workspace: CmsExportWorkspace,
  limits: CmsPackageIntegrityLimits = {}
): Promise<ValidatedCmsPackage> {
  if (envelope.result === null) throw integrityError('export result is unavailable');
  const bounded = normalizeLimits(limits);
  const root = resolve(exportRoot);
  const rootStat = await safeLstat(root, 'export root');
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw integrityError('export root must be a regular directory');
  const canonicalRoot = await realpath(root);

  const artifactPath = confinedPath(root, workspace.artifact.path, 'artifact path');
  const manifestPath = confinedPath(root, workspace.artifact.manifestPath, 'manifest path');
  if (manifestPath !== resolve(artifactPath, CONTROL_FILE))
    throw integrityError('manifest path must be artifact/manifest.json');
  await assertNoReparsePath(root, artifactPath, true);
  await assertNoReparsePath(root, manifestPath, false);
  await assertRealPathConfined(canonicalRoot, artifactPath, 'artifact path');
  await assertRealPathConfined(canonicalRoot, manifestPath, 'manifest path');

  const manifestBytes = await readRegularFile(manifestPath, bounded.maxManifestBytes, 'manifest');
  const manifest = parseManifest(manifestBytes);
  bindManifest(manifest, envelope, workspace);

  const listed = new Map<string, ManifestItem>();
  for (const item of manifest.items) {
    const path = relativePosixPath(item.path, 'manifest item path');
    if (path === CONTROL_FILE) throw integrityError('manifest.json must not be listed in items');
    if (listed.has(path)) throw integrityError(`duplicate manifest item path: ${path}`);
    listed.set(path, {
      path,
      sha256: lowercaseSha256(item.sha256, `item hash ${path}`),
      kind: item.kind,
      ...(item.referenceId === undefined ? {} : { referenceId: item.referenceId }),
    });
  }

  if (listed.size !== manifest.exportedCount) throw integrityError('manifest item count does not match exported count');
  const packageFiles = await enumeratePackageFiles(artifactPath, bounded);
  const actualItems = packageFiles.filter((path) => path !== CONTROL_FILE);
  if (!packageFiles.includes(CONTROL_FILE)) throw integrityError('manifest.json is missing');
  if (actualItems.length !== listed.size)
    throw integrityError('package regular-file set does not match manifest items');
  for (const path of actualItems) {
    if (!listed.has(path)) throw integrityError(`unlisted package file: ${path}`);
  }
  for (const path of listed.keys()) {
    if (!actualItems.includes(path)) throw integrityError(`missing package file: ${path}`);
  }

  let verifiedBytes = manifestBytes.byteLength;
  for (const [path, item] of listed) {
    const itemPath = confinedPath(artifactPath, path, `item path ${path}`);
    // eslint-disable-next-line no-await-in-loop -- hashes must be verified in deterministic order before manifest identity
    await assertNoReparsePath(artifactPath, itemPath, false);
    // eslint-disable-next-line no-await-in-loop -- bounded sequential reads avoid loading the whole package into memory
    const bytes = await readRegularFile(itemPath, bounded.maxFileBytes, `item ${path}`);
    verifiedBytes += bytes.byteLength;
    if (verifiedBytes > bounded.maxTotalBytes) throw integrityError('package exceeds total byte limit');
    if (sha256(bytes) !== item.sha256) throw integrityError(`item hash mismatch: ${path}`);
  }

  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== workspace.artifact.manifestSha256) throw integrityError('manifest hash mismatch');
  assertNoUnresolvedDiagnostics(envelope, workspace);
  const correlations = envelope.result.externalReferenceCorrelations.filter(
    (row) => row.sourceWorkspaceId === workspace.source.sourceId
  );
  for (const row of correlations) {
    if (row.packageManifestSha256 !== manifestSha256) throw integrityError('correlation package identity mismatch');
  }
  assertUsableCorrelations(correlations);

  return {
    sourceWorkspaceId: workspace.source.sourceId,
    artifactPath,
    manifestPath,
    packageManifestSha256: manifestSha256,
    sourceOrgId: envelope.provenance.sourceOrgId,
    pluginVersion: envelope.provenance.pluginVersion,
    exportSetId: envelope.provenance.exportSetId!,
    correlations,
  };
}

async function enumeratePackageFiles(
  artifactPath: string,
  limits: Required<CmsPackageIntegrityLimits>
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) throw integrityError('package traversal depth exceeded');
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      // eslint-disable-next-line no-await-in-loop -- each entry must be lstat-checked before traversal
      const stat = await safeLstat(path, `package entry ${relativePath}`);
      if (stat.isSymbolicLink()) throw integrityError(`symlink or reparse entry is prohibited: ${relativePath}`);
      if (stat.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop -- traversal is intentionally bounded and sequential
        await visit(path, relativePath, depth + 1);
      } else if (stat.isFile()) {
        files.push(relativePath);
        if (files.length > limits.maxFiles) throw integrityError('package file count exceeded');
      } else {
        throw integrityError(`special package entry is prohibited: ${relativePath}`);
      }
    }
  };
  await visit(artifactPath, '', 0);
  return files.sort();
}

function parseManifest(bytes: Buffer): PackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw integrityError('manifest is not valid JSON');
  }
  const record = exactObject(value, MANIFEST_FIELDS, 'manifest');
  const provenance = exactObject(record.provenance, MANIFEST_PROVENANCE_FIELDS, 'manifest provenance');
  if (!Array.isArray(record.items)) throw integrityError('manifest items must be an array');
  assertCompleteManifest(record);
  return {
    exportedCount: record.exportedCount as number,
    contract: text(record.contract, 'manifest contract'),
    contractVersion: text(record.contractVersion, 'manifest contract version'),
    workspaceId: text(record.workspaceId, 'manifest workspaceId'),
    provenance: {
      producer: text(provenance.producer, 'manifest producer'),
      sourceOrgId: text(provenance.sourceOrgId, 'manifest sourceOrgId'),
      sourceWorkspaceId: text(provenance.sourceWorkspaceId, 'manifest sourceWorkspaceId'),
      pluginVersion: text(provenance.pluginVersion, 'manifest pluginVersion'),
    },
    items: record.items.map((itemValue, index) => {
      const item = optionalExactObject(
        itemValue,
        ['path', 'sha256', 'kind'],
        ['referenceId'],
        `manifest item ${index}`
      );
      return {
        path: text(item.path, 'manifest item path'),
        sha256: text(item.sha256, 'manifest item hash'),
        kind: text(item.kind, 'manifest item kind'),
        ...(item.referenceId === undefined ? {} : { referenceId: text(item.referenceId, 'manifest item referenceId') }),
      };
    }),
  };
}

function assertCompleteManifest(record: Record<string, unknown>): void {
  if (record.completeness !== 'complete') throw integrityError('manifest completeness must be complete');
  for (const field of ['expectedCount', 'foundCount', 'exportedCount'] as const) {
    if (!Number.isSafeInteger(record[field]) || (record[field] as number) < 0) {
      throw integrityError('manifest completeness counts must be nonnegative integers');
    }
  }
  if (
    record.expectedCount !== record.foundCount ||
    record.foundCount !== record.exportedCount ||
    !Array.isArray(record.entries) ||
    record.entries.length !== record.exportedCount
  ) {
    throw integrityError('manifest completeness counts are inconsistent');
  }
  for (const field of ['rejectedVariantIds', 'failedVariantIds'] as const) {
    if (!Array.isArray(record[field]) || record[field].length !== 0) {
      throw integrityError('manifest contains rejected or failed variants');
    }
  }
  if (
    !Array.isArray(record.warnings) ||
    record.warnings.some((warning: unknown) => object(warning, 'manifest warning').code !== 'UNSUPPORTED_WILDCARD')
  ) {
    throw integrityError('manifest contains unresolved warnings');
  }
}

function bindManifest(
  manifest: PackageManifest,
  envelope: CmsEnvelope<CmsExportResult>,
  workspace: CmsExportWorkspace
): void {
  if (
    manifest.contract !== workspace.artifact.manifestContract ||
    manifest.contractVersion !== workspace.artifact.manifestContractVersion
  ) {
    throw integrityError('manifest contract binding mismatch');
  }
  if (
    manifest.workspaceId !== workspace.source.sourceId ||
    manifest.provenance.sourceWorkspaceId !== workspace.source.sourceId
  ) {
    throw integrityError('manifest source workspace binding mismatch');
  }
  if (manifest.provenance.producer !== CMS_PLUGIN_NAME) throw integrityError('manifest producer binding mismatch');
  if (manifest.provenance.sourceOrgId !== envelope.provenance.sourceOrgId)
    throw integrityError('manifest source org binding mismatch');
  if (manifest.provenance.pluginVersion !== envelope.provenance.pluginVersion)
    throw integrityError('manifest plugin version binding mismatch');
}

function assertNoUnresolvedDiagnostics(envelope: CmsEnvelope<CmsExportResult>, workspace: CmsExportWorkspace): void {
  if (workspace.status !== 'success') throw integrityError('workspace export is not successful');
  const diagnostics = [
    ...envelope.diagnostics.warnings,
    ...envelope.diagnostics.errors,
    ...workspace.diagnostics.warnings,
    ...workspace.diagnostics.errors,
  ];
  if (diagnostics.some((diagnostic) => diagnostic.reference !== undefined)) {
    throw integrityError('unresolved correlation evidence is diagnosed');
  }
  if (envelope.diagnostics.errors.length > 0 || workspace.diagnostics.errors.length > 0) {
    throw integrityError('export reports unresolved errors');
  }
}

function assertUsableCorrelations(rows: CmsExternalReferenceCorrelation[]): void {
  const sources = new Map<string, string>();
  const references = new Map<string, string>();
  for (const row of rows) {
    const binding = `${row.referenceKind}\0${row.referenceId}\0${row.packageManifestSha256}`;
    const sourcePrior = sources.get(row.sourceReference);
    if (sourcePrior !== undefined)
      throw integrityError(
        sourcePrior === binding ? 'duplicate correlation evidence' : 'conflicting correlation evidence'
      );
    sources.set(row.sourceReference, binding);
    const referenceBinding = `${row.sourceReference}\0${row.referenceKind}\0${row.packageManifestSha256}`;
    const referencePrior = references.get(row.referenceId);
    if (referencePrior !== undefined && referencePrior !== referenceBinding)
      throw integrityError('conflicting referenceId evidence');
    references.set(row.referenceId, referenceBinding);
  }
}

async function assertNoReparsePath(root: string, target: string, targetDirectory: boolean): Promise<void> {
  const relativePath = relative(root, target);
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath))
    throw integrityError('path escapes declared root');
  let current = root;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    // eslint-disable-next-line no-await-in-loop -- every path component must be checked for reparse escapes
    const stat = await safeLstat(current, 'declared package path');
    if (stat.isSymbolicLink()) throw integrityError('symlink or reparse path is prohibited');
  }
  const targetStat = await safeLstat(target, 'declared package path');
  if (targetDirectory ? !targetStat.isDirectory() : !targetStat.isFile())
    throw integrityError('declared package path has wrong entry type');
}

async function assertRealPathConfined(canonicalRoot: string, target: string, label: string): Promise<void> {
  const canonicalTarget = await realpath(target);
  const relation = relative(canonicalRoot, canonicalTarget);
  if (relation.startsWith(`..${sep}`) || relation === '..' || isAbsolute(relation))
    throw integrityError(`${label} escapes export root`);
}

async function readRegularFile(path: string, maximum: number, label: string): Promise<Buffer> {
  const stat = await safeLstat(path, label);
  if (!stat.isFile() || stat.isSymbolicLink()) throw integrityError(`${label} must be a regular file`);
  if (stat.size > maximum) throw integrityError(`${label} exceeds byte limit`);
  const handle = await open(path, 'r');
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size !== stat.size) throw integrityError(`${label} changed during validation`);
    const buffer = Buffer.alloc(current.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) throw integrityError(`${label} changed during validation`);
    return buffer;
  } finally {
    await handle.close();
  }
}

function confinedPath(root: string, declared: string, label: string): string {
  const path = relativePosixPath(declared, label);
  const target = resolve(root, ...path.split('/'));
  const relation = relative(root, target);
  if (relation.startsWith(`..${sep}`) || relation === '..' || isAbsolute(relation))
    throw integrityError(`${label} escapes declared root`);
  return target;
}

function relativePosixPath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw integrityError(`${label} must be a relative POSIX path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..'))
    throw integrityError(`${label} contains traversal or empty segments`);
  return value;
}

function normalizeLimits(limits: CmsPackageIntegrityLimits): Required<CmsPackageIntegrityLimits> {
  const result = {
    maxFiles: limits.maxFiles ?? DEFAULT_MAX_FILES,
    maxTotalBytes: limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxFileBytes: limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxManifestBytes: limits.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES,
    maxDepth: limits.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw integrityError(`${name} must be a positive integer`);
  }
  return result;
}

async function safeLstat(path: string, label: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(path);
  } catch {
    throw integrityError(`${label} is unavailable`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw integrityError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  const record = object(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw integrityError(`${label} fields must be exact`);
  }
  return record;
}

function optionalExactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  const record = object(value, label);
  const actual = Object.keys(record);
  if (
    required.some((field) => !actual.includes(field)) ||
    actual.some((field) => !required.includes(field) && !optional.includes(field))
  ) {
    throw integrityError(`${label} fields must be exact`);
  }
  return record;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw integrityError(`${label} must be a nonempty string`);
  return value;
}

function lowercaseSha256(value: string, label: string): string {
  if (!/^[a-f\d]{64}$/u.test(value)) throw integrityError(`${label} must be lowercase SHA-256`);
  return value;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function integrityError(message: string): CmsPackageIntegrityError {
  return new CmsPackageIntegrityError(`Invalid CMS package: ${message}`);
}
