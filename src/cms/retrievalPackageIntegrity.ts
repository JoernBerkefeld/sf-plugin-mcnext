import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import filesystem, { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  CmsContractError,
  validateCmsExport,
  type CmsDiagnostic,
  type CmsEnvelope,
  type CmsExportResult,
  type CmsExportWorkspace,
} from './contracts.js';

const execute = promisify(execFile);
const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const REPORTS = [
  ['preferencePageReports', 'preference-page', 'preference-pages', 'preferencePage'],
  ['brandReports', 'brand', 'brands', 'brand'],
  ['formReports', 'form', 'forms', 'form'],
  ['formHandlerReports', 'form-handler', 'form-handlers', 'formHandler'],
  ['consentBannerReports', 'consent-banner', 'consent-banners', 'consentBanner'],
] as const;

type RecordValue = Record<string, unknown>;
type Item = { path: string; sha256: string; kind: string; referenceId?: string };
export type ValidatedCmsRetrievalPackage = {
  artifactPath: string;
  files: Array<{ path: string; sha256: string; bytes: Buffer }>;
  completeness: 'complete' | 'partial';
  diagnostics: CmsDiagnostic[];
};

/** Read public retrieval integrity metadata only; retain precisely the bytes checked for publication. */
export async function validateCmsRetrievalPackage(
  exportRoot: string,
  envelope: CmsEnvelope<CmsExportResult>,
  workspace: CmsExportWorkspace,
  advertisedManifestVersions: readonly string[]
): Promise<ValidatedCmsRetrievalPackage> {
  return validateCmsRetrievalPackageWithinBudget(
    exportRoot,
    envelope,
    workspace,
    advertisedManifestVersions,
    MAX_TOTAL_BYTES
  );
}

/** Internal publisher boundary: reserve all source sizes before allocating any package bytes. */
// eslint-disable-next-line complexity -- one fail-closed package boundary binds verified bytes to provider evidence
export async function validateCmsRetrievalPackageWithinBudget(
  exportRoot: string,
  envelope: CmsEnvelope<CmsExportResult>,
  workspace: CmsExportWorkspace,
  advertisedManifestVersions: readonly string[],
  remainingBytes: number
): Promise<ValidatedCmsRetrievalPackage> {
  const validated = validateCmsExport(envelope);
  const row = validated.result?.workspaces.find((entry) => entry.source.sourceId === workspace.source.sourceId);
  if (
    !row ||
    JSON.stringify(row) !== JSON.stringify(workspace) ||
    !workspace.artifact ||
    (workspace.status !== 'success' && workspace.status !== 'partial')
  )
    fail('unusable workspace evidence');
  const artifact = workspace.artifact;
  const artifactPath = portablePath(artifact.path);
  if (portablePath(artifact.manifestPath) !== `${artifactPath}/manifest.json`) fail('manifest path binding');
  const root = resolve(exportRoot);
  await checkAncestors(root);
  const packageRoot = join(root, ...artifactPath.split('/'));
  await checkAncestors(packageRoot);
  if (!(await lstat(packageRoot)).isDirectory()) fail('artifact must be a directory');
  const manifestMetadata = await lstat(join(packageRoot, 'manifest.json'));
  if (!manifestMetadata.isFile() || manifestMetadata.size > MAX_MANIFEST_BYTES) fail('regular-file byte limit');
  const paths = await enumerate(packageRoot);
  const reservations = new Map<string, number>();
  let reserved = 0;
  for (const path of paths) {
    // eslint-disable-next-line no-await-in-loop -- preflight every size before allocating even the manifest
    const metadata = await lstat(join(packageRoot, ...path.split('/')));
    const maximum = path === 'manifest.json' ? MAX_MANIFEST_BYTES : MAX_FILE_BYTES;
    if (!metadata.isFile() || metadata.size > maximum) fail('regular-file byte limit');
    reserved += metadata.size;
    if (reserved > Math.min(MAX_TOTAL_BYTES, remainingBytes)) fail('CMS publication batch budget exceeded');
    reservations.set(path, metadata.size);
  }
  const manifestBytes = await readBounded(join(packageRoot, 'manifest.json'), reservations.get('manifest.json') ?? 0);
  const manifestSha256 = digest(manifestBytes);
  if (manifestSha256 !== artifact.manifestSha256) fail('manifest hash mismatch');
  const manifest = json(manifestBytes);
  bindManifest(manifest, validated, workspace, advertisedManifestVersions);
  const items = list(manifest.items).map(parseItem);
  assertDeclarationAliases(['manifest.json', ...items.map((item) => item.path)]);
  const listed = new Map(items.map((item) => [item.path, item]));
  if (listed.size !== items.length || listed.has('manifest.json')) fail('duplicate or control-file declaration');
  if (paths.length !== listed.size + 1 || paths.some((path) => path !== 'manifest.json' && !listed.has(path)))
    fail('exact declared regular-file set mismatch');
  const files: ValidatedCmsRetrievalPackage['files'] = [
    { path: 'manifest.json', sha256: manifestSha256, bytes: manifestBytes },
  ];
  let total = manifestBytes.length;
  for (const path of paths.filter((entry) => entry !== 'manifest.json')) {
    // eslint-disable-next-line no-await-in-loop -- bounded sequential reads retain only verified package bytes
    const bytes = await readBounded(join(packageRoot, ...path.split('/')), reservations.get(path)!);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) fail('total byte limit exceeded');
    const sha256 = digest(bytes);
    if (sha256 !== listed.get(path)!.sha256) fail(`item hash mismatch: ${path}`);
    files.push({ path, sha256, bytes });
  }
  const bytesByPath = new Map(files.map((file) => [file.path, file.bytes]));
  const incomplete = validateBindings(manifest, listed, bytesByPath, validated, workspace, manifestSha256);
  if (manifest.completeness !== 'complete' && manifest.completeness !== 'partial') fail('invalid completeness');
  if (manifest.completeness === 'complete' && incomplete) fail('false complete claim');
  const diagnostics: CmsDiagnostic[] = [
    ...validated.diagnostics.warnings.filter(
      (entry) => entry.scope === undefined || entry.scope === workspace.source.sourceId
    ),
    ...validated.diagnostics.errors.filter(
      (entry) => entry.scope === undefined || entry.scope === workspace.source.sourceId
    ),
    ...workspace.diagnostics.warnings,
    ...workspace.diagnostics.errors,
  ];
  if (artifact.manifestContractVersion !== manifest.contractVersion)
    diagnostics.push({
      code: 'CMS_RETRIEVAL_MANIFEST_VERSION_DISCREPANCY',
      message:
        'The bulk wrapper declares manifest version 1; the verified embedded package uses explicitly advertised version 2.',
      scope: workspace.source.sourceId,
    });
  return {
    artifactPath,
    files,
    completeness:
      incomplete ||
      workspace.status === 'partial' ||
      diagnostics.some(
        (entry) => entry.code !== 'UNSUPPORTED_WILDCARD' && entry.code !== 'CMS_RETRIEVAL_MANIFEST_VERSION_DISCREPANCY'
      )
        ? 'partial'
        : manifest.completeness,
    diagnostics,
  };
}

// eslint-disable-next-line complexity -- explicit public manifest metadata checks avoid a general schema framework
function bindManifest(
  manifest: RecordValue,
  envelope: CmsEnvelope<CmsExportResult>,
  workspace: CmsExportWorkspace,
  advertised: readonly string[]
): void {
  const required = [
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
  ];
  const optional = ['media', 'landingPageTemplatePairs', ...REPORTS.map(([field]) => field)];
  keys(manifest, required, optional);
  const version = manifest.schemaVersion === 1 ? '1.0.0' : manifest.schemaVersion === 2 ? '2.0.0' : '';
  if (!version || manifest.contractVersion !== version || !advertised.includes(version))
    fail('unsupported or unadvertised manifest version');
  if (manifest.contract !== 'sf-cms-workspace-export' || manifest.mode !== 'experimental-best-effort')
    fail('unsupported manifest contract');
  const provenance = record(manifest.provenance);
  keys(provenance, ['producer', 'sourceOrgId', 'sourceWorkspaceId', 'pluginVersion', 'generatedAt']);
  if (
    manifest.workspaceId !== workspace.source.sourceId ||
    provenance.sourceWorkspaceId !== workspace.source.sourceId ||
    provenance.producer !== 'sf-plugin-cms' ||
    provenance.sourceOrgId !== envelope.provenance.sourceOrgId ||
    provenance.pluginVersion !== envelope.provenance.pluginVersion
  )
    fail('manifest provenance binding');
  text(provenance.generatedAt);
  for (const field of ['expectedCount', 'foundCount', 'exportedCount', 'pagesRequested']) count(manifest[field]);
  const search = record(manifest.search);
  keys(search, ['contentSpaceOrFolderIds', 'languages', 'pageSize', 'queryTerm']);
  if (
    JSON.stringify(search.contentSpaceOrFolderIds) !== JSON.stringify([manifest.workspaceId]) ||
    JSON.stringify(search.languages) !== '["All"]' ||
    search.pageSize !== 250 ||
    search.queryTerm !== '*'
  )
    fail('manifest search binding');
  if (list(manifest.dependencies).length !== 0) fail('unsupported dependency declarations');
  for (const field of ['rejectedVariantIds', 'failedVariantIds']) for (const id of list(manifest[field])) text(id);
  for (const warning of list(manifest.warnings)) {
    const value = record(warning);
    keys(value, ['code', 'message'], ['variantIds']);
    text(value.code);
    text(value.message);
    if (value.variantIds !== undefined) for (const id of list(value.variantIds)) text(id);
  }
  if (manifest.schemaVersion === 1 && manifest.media !== undefined) fail('schema 1 cannot declare media');
  if (manifest.schemaVersion === 2) list(manifest.media);
}

function validateBindings(
  manifest: RecordValue,
  items: Map<string, Item>,
  bytes: Map<string, Buffer>,
  envelope: CmsEnvelope<CmsExportResult>,
  workspace: CmsExportWorkspace,
  manifestHash: string
): boolean {
  const entries = new Map<string, string>();
  const variants = new Set<string>();
  for (const value of list(manifest.entries)) {
    const entry = record(value);
    keys(entry, ['file', 'variantId']);
    const path = portablePath(text(entry.file));
    const variant = text(entry.variantId);
    if (entries.has(path) || variants.has(variant) || items.get(path)?.kind !== 'cms.content')
      fail('raw entry binding');
    entries.set(path, variant);
    variants.add(variant);
  }
  const raw = [...items.values()].filter((item) => item.kind === 'cms.content');
  if (raw.length !== entries.size || manifest.exportedCount !== entries.size) fail('raw content count binding');
  validateReports(manifest, items, entries, bytes);
  validatePairs(manifest, entries, bytes);
  validateMedia(manifest, items, entries, bytes);
  const unresolved = validateReferences(manifest, items, envelope, workspace, manifestHash);
  return (
    unresolved ||
    manifest.expectedCount !== manifest.foundCount ||
    manifest.foundCount !== manifest.exportedCount ||
    list(manifest.rejectedVariantIds).length > 0 ||
    list(manifest.failedVariantIds).length > 0 ||
    list(manifest.warnings).some((warning) => record(warning).code !== 'UNSUPPORTED_WILDCARD')
  );
}

// eslint-disable-next-line complexity -- five producer report families share the same bounded integrity bindings
function validateReports(
  manifest: RecordValue,
  items: Map<string, Item>,
  entries: Map<string, string>,
  bytes: Map<string, Buffer>
): void {
  for (const [field, family, directory, type] of REPORTS) {
    const descriptors = manifest[field] === undefined ? [] : list(manifest[field]);
    if (manifest[field] !== undefined && descriptors.length === 0) fail('empty report descriptors');
    const paths = new Set<string>();
    const variants = new Set<string>();
    for (const value of descriptors) {
      const descriptor = record(value);
      keys(descriptor, ['path', 'rawItemPath', 'workspaceId', 'contentType', 'variantId', 'apiName', 'format']);
      const path = portablePath(text(descriptor.path));
      const rawPath = portablePath(text(descriptor.rawItemPath));
      const variant = text(descriptor.variantId);
      text(descriptor.apiName);
      if (
        path !== `reports/${directory}/${variant}.json` ||
        !rawPath.startsWith('items/') ||
        !rawPath.endsWith('.json') ||
        descriptor.workspaceId !== manifest.workspaceId ||
        descriptor.contentType !== `sfdc_cms__${type}` ||
        descriptor.format !== `sf-cms-${family}-read-report@1` ||
        paths.has(path) ||
        variants.has(variant) ||
        entries.get(rawPath) !== variant ||
        items.get(path)?.kind !== `cms.${family}.read-report`
      )
        fail('report descriptor binding');
      paths.add(path);
      variants.add(variant);
      const report = json(bytes.get(path)!);
      for (const key of ['rawItemPath', 'workspaceId', 'variantId', 'apiName', 'format']) {
        if (report[key] !== descriptor[key]) fail('report payload identity binding');
      }
      const provenance = record(record(report.normalization).provenance);
      if (provenance.contentSpaceId !== manifest.workspaceId || provenance.managedContentVariantId !== variant)
        fail('report provenance binding');
    }
    if ([...items.values()].filter((item) => item.kind === `cms.${family}.read-report`).length !== paths.size)
      fail('report item bijection');
  }
}

function validatePairs(manifest: RecordValue, entries: Map<string, string>, bytes: Map<string, Buffer>): void {
  if (manifest.landingPageTemplatePairs === undefined) return;
  const pairs = list(manifest.landingPageTemplatePairs);
  if (pairs.length === 0) fail('empty landing pairs');
  const pages = new Set<string>();
  for (const value of pairs) {
    const pair = record(value);
    keys(pair, ['page', 'template', 'compatibility']);
    const page = record(pair.page);
    const template = record(pair.template);
    keys(page, ['apiName', 'contentKey', 'variantId']);
    keys(template, ['requestedTitle', 'apiName', 'contentKey', 'variantId']);
    const compatibility = record(pair.compatibility);
    keys(compatibility, ['basis', 'relationship']);
    if (
      compatibility.basis !== 'declared-source-pair' ||
      compatibility.relationship !== 'opaque-structural-match' ||
      page.variantId === template.variantId ||
      pages.has(text(page.variantId))
    )
      fail('landing pair binding');
    pages.add(text(page.variantId));
    for (const identity of [page, template]) {
      for (const field of Object.values(identity)) text(field);
      const path = [...entries].find(([, variant]) => variant === identity.variantId)?.[0];
      if (!path) fail('landing pair raw binding');
      const raw = json(bytes.get(path)!);
      if (raw.apiName !== identity.apiName || raw.contentKey !== identity.contentKey)
        fail('landing pair payload binding');
    }
  }
}

// eslint-disable-next-line complexity -- media bytes, descriptor and raw authoring identity must all agree
function validateMedia(
  manifest: RecordValue,
  items: Map<string, Item>,
  entries: Map<string, string>,
  bytes: Map<string, Buffer>
): void {
  const media = manifest.media === undefined ? [] : list(manifest.media);
  const paths = new Set<string>();
  const variants = new Set<string>();
  for (const value of media) {
    const descriptor = record(value);
    keys(descriptor, [
      'variantId',
      'contentKey',
      'path',
      'sha256',
      'md5',
      'bytes',
      'mimeType',
      'fileName',
      'sourceStatus',
      'sourceModifiedAt',
      'sourceVersion',
      'sourceUrl',
      'transport',
    ]);
    const path = portablePath(text(descriptor.path));
    const variant = text(descriptor.variantId);
    const item = items.get(path);
    const data = bytes.get(path);
    const rawPath = [...entries].find(([, id]) => id === variant)?.[0];
    if (
      !path.startsWith('media/') ||
      paths.has(path) ||
      variants.has(variant) ||
      !rawPath ||
      !data ||
      item?.kind !== 'cms.media' ||
      item.sha256 !== descriptor.sha256 ||
      count(descriptor.bytes) !== data.length ||
      descriptor.md5 !== digest(data, 'md5') ||
      descriptor.transport !== 'experimental-undocumented-authoring-media'
    )
      fail('media integrity binding');
    paths.add(path);
    variants.add(variant);
    const raw = json(bytes.get(rawPath)!);
    const nodes = record(raw.contentBody);
    const mediaNode = record(nodes['sfdc_cms:media']);
    const source = record(mediaNode.source);
    const status = record(raw.status);
    if (
      raw.contentKey !== descriptor.contentKey ||
      mediaNode.url !== descriptor.sourceUrl ||
      source.size !== descriptor.bytes ||
      source.mimeType !== descriptor.mimeType ||
      status.status !== descriptor.sourceStatus ||
      raw.lastModifiedDate !== descriptor.sourceModifiedAt
    )
      fail('media source binding');
    const url = new URL(text(descriptor.sourceUrl), 'https://invalid.example');
    if (
      url.searchParams.get('fileName') !== descriptor.fileName ||
      url.searchParams.get('fileHash')?.toLowerCase() !== descriptor.md5 ||
      url.searchParams.get('version') !== descriptor.sourceVersion ||
      path !== `media/${variant}-${text(descriptor.fileName)}`
    )
      fail('media URL binding');
  }
  if ([...items.values()].filter((item) => item.kind === 'cms.media').length !== paths.size)
    fail('media item bijection');
}

function validateReferences(
  manifest: RecordValue,
  items: Map<string, Item>,
  envelope: CmsEnvelope<CmsExportResult>,
  workspace: CmsExportWorkspace,
  hash: string
): boolean {
  const references = new Map<string, RecordValue>();
  const expected = new Set<string>();
  let unresolved = false;
  for (const value of list(manifest.externalReferences)) {
    const reference = record(value);
    keys(reference, ['referenceId', 'owner', 'kind', 'source', 'portableKey', 'required', 'resolution']);
    const source = record(reference.source);
    keys(source, ['workspaceId', 'sourceId']);
    text(source.sourceId);
    const portable = record(reference.portableKey);
    keys(portable, ['scheme', 'value']);
    text(portable.value);
    const id = text(reference.referenceId);
    text(reference.kind);
    if (
      references.has(id) ||
      source.workspaceId !== manifest.workspaceId ||
      reference.owner !== 'cms' ||
      portable.scheme !== 'cms-opaque-v1' ||
      typeof reference.required !== 'boolean' ||
      !['included', 'unresolved', 'unsupported', 'external'].includes(text(reference.resolution))
    )
      fail('external reference binding');
    references.set(id, reference);
    if (reference.resolution === 'unresolved' || reference.resolution === 'unsupported') unresolved = true;
    else if (reference.resolution === 'included' && reference.kind === 'cms.content')
      expected.add(`${text(portable.value)}\0${text(reference.kind)}\0${id}`);
  }
  for (const item of items.values())
    if (item.referenceId !== undefined && !references.has(item.referenceId)) fail('orphan item reference');
  const actual = new Set<string>();
  for (const row of envelope.result!.externalReferenceCorrelations.filter(
    (entry) => entry.sourceWorkspaceId === workspace.source.sourceId
  )) {
    if (row.packageManifestSha256 !== hash) fail('correlation hash binding');
    actual.add(`${row.sourceReference}\0${row.referenceKind}\0${row.referenceId}`);
  }
  if (actual.size !== expected.size || [...expected].some((binding) => !actual.has(binding)))
    fail('included correlation bijection');
  return unresolved;
}

async function enumerate(root: string): Promise<string[]> {
  const files: string[] = [];
  const aliases = new Map<string, string>();
  let nodes = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 32) fail('traversal depth exceeded');
    for (const name of await readdir(directory)) {
      if (++nodes > MAX_FILES) fail('file count exceeded');
      const path = portablePath(prefix ? `${prefix}/${name}` : name);
      const key = path.normalize('NFKC').toLowerCase();
      if (aliases.has(key)) fail('case or NFKC path alias');
      aliases.set(key, path);
      const absolute = join(directory, name);
      // eslint-disable-next-line no-await-in-loop -- inspect each path before traversal
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) fail('source link or reparse entry');
      if (metadata.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop -- bounded deterministic traversal
        await visit(absolute, path, depth + 1);
      } else if (metadata.isFile()) files.push(path);
      else fail('source special file');
    }
  };
  // The Win32 scan catches reparse types that Node does not classify as symlinks.
  await checkAncestors(root, true);
  await visit(root, '', 0);
  return files.sort();
}

async function checkAncestors(target: string, subtree = false): Promise<void> {
  if (process.platform === 'win32')
    await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
    $ErrorActionPreference = 'Stop'
    $current = $env:SF_MCNEXT_RETRIEVAL_PATH
    while ($true) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source reparse point rejected' }
      $parent = [IO.Path]::GetDirectoryName($current)
      if (-not $parent -or $parent -eq $current) { break }
      $current = $parent
    }
    if ($env:SF_MCNEXT_RETRIEVAL_SUBTREE -eq 'true') {
      $pending = New-Object 'Collections.Generic.Stack[string]'
      $pending.Push($env:SF_MCNEXT_RETRIEVAL_PATH)
      while ($pending.Count -gt 0) {
        $item = Get-Item -LiteralPath $pending.Pop() -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source reparse point rejected' }
        if ($item.PSIsContainer) { foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) { $pending.Push($child.FullName) } }
      }
    }`,
      ],
      {
        env: { ...process.env, SF_MCNEXT_RETRIEVAL_PATH: target, SF_MCNEXT_RETRIEVAL_SUBTREE: String(subtree) },
        windowsHide: true,
      }
    );
  let current = target;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- every source ancestor must be checked
    if ((await lstat(current)).isSymbolicLink()) fail('source ancestor link');
    const parent = dirname(current);
    if (current === parent) break;
    current = parent;
  }
  if (resolve(await realpath(target)).toLowerCase() !== resolve(target).toLowerCase())
    fail('source canonical path mismatch');
}

async function readBounded(path: string, maximum: number): Promise<Buffer> {
  await checkAncestors(path);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > maximum) fail('regular-file byte limit');
  const handle = await filesystem.open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== metadata.size || stat.ino !== metadata.ino || stat.dev !== metadata.dev)
      fail('source changed while opening');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      // eslint-disable-next-line no-await-in-loop -- handle short reads without unbounded allocation
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) fail('source truncated during read');
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('source changed during read');
    return bytes;
  } finally {
    await handle.close();
  }
}

function portablePath(value: string): string {
  const path = value.startsWith('./') ? value.slice(2) : value;
  if (!path || parse(path).root || path.includes('\\')) fail('relative POSIX path required');
  for (const component of path.split('/'))
    for (const form of [component, component.normalize('NFKC')]) {
      if (
        !form ||
        form === '.' ||
        form === '..' ||
        [...form].some((character) => character.charCodeAt(0) < 32) ||
        /[<>:"|?*\\/]/u.test(form) ||
        /[. ]$/u.test(form) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(form)
      )
        fail('invalid portable path component');
    }
  return path;
}
function assertDeclarationAliases(paths: string[]): void {
  const prefixes = new Map<string, string>();
  const files = new Set(paths.map((path) => path.normalize('NFKC').toLowerCase()));
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const key = prefix.normalize('NFKC').toLowerCase();
      if (prefixes.has(key) && prefixes.get(key) !== prefix) fail('case or NFKC declaration alias');
      if (index < parts.length && files.has(key)) fail('file ancestor declaration conflict');
      prefixes.set(key, prefix);
    }
  }
}
function parseItem(value: unknown): Item {
  const item = record(value);
  keys(item, ['path', 'sha256', 'kind'], ['referenceId']);
  const sha256 = text(item.sha256);
  if (!/^[a-f\d]{64}$/u.test(sha256)) fail('invalid item hash');
  return {
    path: portablePath(text(item.path)),
    sha256,
    kind: text(item.kind),
    ...(item.referenceId === undefined ? {} : { referenceId: text(item.referenceId) }),
  };
}
function json(bytes: Buffer): RecordValue {
  return record(JSON.parse(bytes.toString('utf8')) as unknown);
}
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('metadata object required');
  return value as RecordValue;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail('metadata array required');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length) fail('metadata string required');
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('nonnegative count required');
  return value as number;
}
function keys(value: RecordValue, required: readonly string[], optional: readonly string[] = []): void {
  if (
    required.some((field) => !Object.hasOwn(value, field)) ||
    Object.keys(value).some((field) => !required.includes(field) && !optional.includes(field))
  )
    fail('unsupported metadata fields');
}
function digest(bytes: Buffer, algorithm = 'sha256'): string {
  return createHash(algorithm).update(bytes).digest('hex');
}
function fail(message: string): never {
  throw new CmsContractError(`Invalid CMS retrieval package: ${message}`);
}
