import { execFile } from 'node:child_process';
import filesystem, { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Org } from '@salesforce/core';
import { redact, runCmsExport, runCmsRegistryInfo, type CmsCliOptions } from '../cms/cmsCli.js';
import {
  CMS_BULK_EXPORT_CAPABILITY,
  CMS_CORRELATION_CAPABILITY,
  CMS_CORRELATION_CONTRACT,
  CMS_EXPORT_CONTRACT,
  type CmsDiagnostic,
  type CmsEnvelope,
  type CmsExportResult,
  type CmsInfoResultV2,
  type CmsRegistryResult,
  type CmsStatus,
} from '../cms/contracts.js';
import {
  validateCmsRetrievalPackageWithinBudget,
  type ValidatedCmsRetrievalPackage,
} from '../cms/retrievalPackageIntegrity.js';
import {
  assertRunOwnedPath,
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
  type RunOwnedTemp,
} from '../filesystem/runOwnedTemp.js';

export type MarketingCmsRetrievalInput = {
  projectRoot: string;
  targetOrg: string;
  expectedOrgId: string;
  apiVersion: string;
};
export type MarketingCmsRetrievalServices = {
  createOrg?: (targetOrg: string) => Promise<Org>;
  cli?: CmsCliOptions;
};
export type MarketingCmsRetrievalResult = {
  provider: 'sf-plugin-cms';
  workspaceType: 'Marketing';
  state: CmsStatus;
  diagnostics: CmsDiagnostic[];
  registry?: CmsRegistryResult;
  exportEnvelope?: CmsEnvelope<CmsExportResult>;
  stagingDirectory?: string;
  stagingOwner?: RunOwnedTemp;
  publication: 'not-attempted';
};
export type MarketingCmsPublicationResult = {
  provider: 'sf-plugin-cms';
  workspaceType: 'Marketing';
  state: CmsStatus;
  publication: 'not-attempted' | 'success' | 'partial' | 'blocked' | 'failed';
  diagnostics: CmsDiagnostic[];
  workspaces: Array<{
    sourceWorkspaceId: string;
    sourceStatus: CmsStatus;
    publication: MarketingCmsPublicationResult['publication'];
    files: string[];
  }>;
  files: string[];
  stagingDirectory?: string;
  stagingOwner?: RunOwnedTemp;
};
type RetrievalBinding = {
  input: MarketingCmsRetrievalInput;
  snapshot: string;
  owner?: RunOwnedTemp;
  stage?: string;
  versions: readonly string[];
  usable: boolean;
};
const bindings = new WeakMap<MarketingCmsRetrievalResult, RetrievalBinding>();
const execute = promisify(execFile);

/** Retrieve public Marketing CMS evidence into retained staging, never into the project. */
export async function retrieveMarketingCms(
  input: MarketingCmsRetrievalInput,
  services: MarketingCmsRetrievalServices = {}
): Promise<MarketingCmsRetrievalResult> {
  const result: MarketingCmsRetrievalResult = {
    provider: 'sf-plugin-cms',
    workspaceType: 'Marketing',
    state: 'blocked',
    diagnostics: [],
    publication: 'not-attempted',
  };
  let exportAttempted = false;
  let versions: readonly string[] = [];
  let usable = false;
  const originalInput = { ...input };
  try {
    const packageRoots = await validateProject(input.projectRoot);
    if (!input.targetOrg.trim() || input.targetOrg.includes('\0') || !input.expectedOrgId.trim()) {
      throw new Error('Selected org and expected org identity are required');
    }
    const org = await (services.createOrg ?? ((targetOrg): Promise<Org> => Org.create({ aliasOrUsername: targetOrg })))(
      input.targetOrg
    );
    const orgId = org.getOrgId();
    if (orgId !== input.expectedOrgId) throw new Error('Fresh selected org does not match expected org identity');
    const discovery = await runCmsRegistryInfo(services.cli);
    result.registry = discovery.registry;
    const info = discovery.envelope.result!;
    negotiate(info, input.apiVersion);
    versions = [...info.contracts.packageManifests.workspaceExport];
    const owner = await createRunOwnedTemp('mcnext-marketing-cms');
    result.stagingOwner = owner;
    const staging = await createRunOwnedDirectory(owner, 'cms');
    result.stagingDirectory = staging;
    if (packageRoots.some((root) => inside(root, staging))) {
      throw new Error('CMS staging must be outside native package roots');
    }
    exportAttempted = true;
    const envelope = await runCmsExport(input.targetOrg, staging, services.cli);
    exportAttempted = false; // Validated transport is complete; subsequent provenance failures block use.
    result.diagnostics.push(...envelope.diagnostics.warnings, ...envelope.diagnostics.errors);
    // Null terminal evidence is not usable output and unresolved-org is never org proof.
    if (envelope.result === null) {
      bindProvider(envelope, info, input.apiVersion, true);
      if (envelope.status === 'blocked') {
        result.exportEnvelope = envelope;
        result.state = 'blocked';
      } else {
        result.state = 'failed';
      }
      return result;
    }
    bindProvider(envelope, info, input.apiVersion, false);
    if (envelope.provenance.sourceOrgId !== orgId) throw new Error('CMS export selected-org binding mismatch');
    // The producer reports a portable label; ownership and the exact invocation bind the absolute stage.
    if (envelope.result.outputDirectory !== basename(staging))
      throw new Error('CMS export staging label binding mismatch');
    result.exportEnvelope = envelope;
    result.state = envelope.status;
    usable = true;
  } catch (error) {
    result.state = exportAttempted ? 'failed' : 'blocked';
    result.diagnostics.push({
      code: exportAttempted ? 'CMS_RETRIEVAL_FAILED' : 'CMS_RETRIEVAL_BLOCKED',
      message: redact(error instanceof Error ? error.message : String(error)),
      retryable: false,
    });
  } finally {
    bindings.set(result, {
      input: originalInput,
      snapshot: JSON.stringify(result),
      owner: result.stagingOwner,
      stage: result.stagingDirectory,
      versions,
      usable,
    });
  }
  return result;
}

/** Publish only ephemeral, unchanged evidence returned by this process's staged resolver. */
// eslint-disable-next-line complexity -- publication distinguishes preflight, partial writes and guarded cleanup truthfully
export async function publishMarketingCms(
  input: MarketingCmsRetrievalInput,
  retrieval: MarketingCmsRetrievalResult
): Promise<MarketingCmsPublicationResult> {
  const result: MarketingCmsPublicationResult = {
    provider: 'sf-plugin-cms',
    workspaceType: 'Marketing',
    state: retrieval.state,
    publication: 'not-attempted',
    diagnostics: [...retrieval.diagnostics],
    files: [],
    workspaces: (retrieval.exportEnvelope?.result?.workspaces ?? []).map((row) => ({
      sourceWorkspaceId: row.source.sourceId,
      sourceStatus: row.status,
      publication: 'not-attempted',
      files: [],
    })),
    stagingDirectory: retrieval.stagingDirectory,
    stagingOwner: retrieval.stagingOwner,
  };
  let writing = false;
  let attemptedPath = '';
  let active: MarketingCmsPublicationResult['workspaces'][number] | undefined;
  try {
    const binding = bindings.get(retrieval);
    if (
      !binding ||
      binding.input.projectRoot !== input.projectRoot ||
      binding.input.targetOrg !== input.targetOrg ||
      binding.input.expectedOrgId !== input.expectedOrgId ||
      binding.input.apiVersion !== input.apiVersion ||
      binding.snapshot !== JSON.stringify(retrieval) ||
      binding.owner !== retrieval.stagingOwner ||
      binding.stage !== retrieval.stagingDirectory
    )
      throw new Error('Forged or changed CMS retrieval context');
    if (!binding.usable) return result;
    const envelope = JSON.parse(JSON.stringify(retrieval.exportEnvelope)) as CmsEnvelope<CmsExportResult>;
    const context = { ...binding.input };
    const state = envelope.status;
    const roots = await validateProject(context.projectRoot);
    const stage = binding.stage!;
    const owner = binding.owner!;
    await assertRunOwnedPath(owner, stage);
    const output = join(context.projectRoot, 'cms');
    if (roots.some((root) => overlaps(root, output)) || overlaps(stage, context.projectRoot))
      throw new Error('CMS output overlaps native roots or staging');
    const candidates: Array<{ package: ValidatedCmsRetrievalPackage; row: (typeof result.workspaces)[number] }> = [];
    let fileCount = 0;
    let byteCount = 0;
    for (const [index, row] of envelope.result!.workspaces.entries()) {
      if (!row.artifact || (row.status !== 'success' && row.status !== 'partial')) continue;
      // eslint-disable-next-line no-await-in-loop -- all candidates are verified before any project writes
      const pkg = await validateCmsRetrievalPackageWithinBudget(
        stage,
        envelope,
        row,
        binding.versions,
        256 * 1024 * 1024 - byteCount
      );
      fileCount += pkg.files.length;
      byteCount += pkg.files.reduce((total, file) => total + file.bytes.length, 0);
      if (fileCount > 10_000 || byteCount > 256 * 1024 * 1024 || candidates.length >= 10_000)
        throw new Error('CMS publication batch budget exceeded');
      candidates.push({ package: pkg, row: result.workspaces[index] });
      result.diagnostics.push(...pkg.diagnostics);
    }
    const prefixes = new Map<string, string>();
    for (const candidate of candidates) {
      const parts = candidate.package.artifactPath.split('/');
      for (let index = 1; index <= parts.length; index++) {
        const prefix = parts.slice(0, index).join('/');
        const key = pathKey(prefix);
        if (prefixes.has(key) && prefixes.get(key) !== prefix) throw new Error('CMS workspace ancestor alias');
        prefixes.set(key, prefix);
      }
    }
    const destinations = candidates.map((candidate) => join(output, ...candidate.package.artifactPath.split('/')));
    for (const [index, destination] of destinations.entries()) {
      if (destinations.some((other, otherIndex) => otherIndex !== index && overlaps(destination, other)))
        throw new Error('CMS workspace destinations overlap or alias');
      // eslint-disable-next-line no-await-in-loop -- every destination must pass before the first write
      await inspectDestination(context.projectRoot, destination, true);
    }
    if (!candidates.length && (state !== 'success' || result.workspaces.length)) {
      result.state = 'failed';
      return result;
    }
    writing = true;
    for (const [index, candidate] of candidates.entries()) {
      active = candidate.row;
      const destination = destinations[index];
      attemptedPath = destination;
      // eslint-disable-next-line no-await-in-loop -- exclusive workspace creation is serialized
      await createDestination(context.projectRoot, destination, true);
      const files = [...candidate.package.files].sort(
        (a, b) =>
          Number(a.path === 'manifest.json') - Number(b.path === 'manifest.json') || a.path.localeCompare(b.path)
      );
      for (const file of files) {
        attemptedPath = join(destination, ...file.path.split('/'));
        // eslint-disable-next-line no-await-in-loop -- directories and exclusive writes must stay ordered
        await createDestination(context.projectRoot, dirname(attemptedPath), false);
        // eslint-disable-next-line no-await-in-loop -- recheck ancestors immediately before exclusive open
        await inspectDestination(context.projectRoot, attemptedPath, true);
        // eslint-disable-next-line no-await-in-loop -- close the alias/race window by checking the immediate parent again
        await safePath(dirname(attemptedPath));
        // eslint-disable-next-line no-await-in-loop -- never replace user files
        const handle = await filesystem.open(attemptedPath, 'wx');
        try {
          // eslint-disable-next-line no-await-in-loop -- write exactly the already verified bytes
          await handle.writeFile(file.bytes);
        } finally {
          // eslint-disable-next-line no-await-in-loop -- only a successfully closed file enters the result
          await handle.close();
        }
        active.files.push(attemptedPath);
        result.files.push(attemptedPath);
      }
      active.publication =
        candidate.package.completeness === 'partial' || active.sourceStatus !== 'success' ? 'partial' : 'success';
    }
    const complete = state === 'success' && result.workspaces.every((row) => row.publication === 'success');
    result.state = complete ? 'success' : 'partial';
    result.publication = result.state;
    if (complete) {
      try {
        await removeRunOwnedPath(owner, stage);
        delete result.stagingDirectory;
        await removeRunOwnedRoot(owner);
        delete result.stagingOwner;
      } catch (error) {
        result.diagnostics.push(publicationDiagnostic('CMS_PUBLICATION_CLEANUP_WARNING', error));
      }
    }
  } catch (error) {
    result.state = writing ? (result.files.length ? 'partial' : 'failed') : 'blocked';
    result.publication = result.state;
    if (active) active.publication = active.files.length ? 'partial' : 'failed';
    if (!writing)
      for (const row of result.workspaces)
        if (row.sourceStatus === 'success' || row.sourceStatus === 'partial') row.publication = 'blocked';
    result.diagnostics.push(
      publicationDiagnostic(
        'CMS_PUBLICATION_FAILED',
        error,
        attemptedPath ? relative(input.projectRoot, attemptedPath) : ''
      )
    );
  }
  return result;
}

/** Internal coordinator seam: one staged retrieval followed by one exclusive publication. */
export async function retrieveAndPublishMarketingCms(
  input: MarketingCmsRetrievalInput,
  services?: MarketingCmsRetrievalServices
): Promise<{ retrieval: MarketingCmsRetrievalResult; publication: MarketingCmsPublicationResult }> {
  const retrieval = await retrieveMarketingCms(input, services);
  return { retrieval, publication: await publishMarketingCms(input, retrieval) };
}

function publicationDiagnostic(code: string, error: unknown, path = ''): CmsDiagnostic {
  return {
    code,
    message: redact(error instanceof Error ? error.message : String(error)),
    ...(path ? { scope: redact(path.replace(/\\/gu, '/')) } : {}),
    retryable: false,
  };
}
function pathKey(path: string): string {
  return path.normalize('NFKC').toLowerCase();
}
function overlaps(left: string, right: string): boolean {
  return inside(pathKey(left), pathKey(right)) || inside(pathKey(right), pathKey(left));
}
export function validateComponents(path: string): void {
  for (const component of path.split(/[\\/]/u)) {
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
        throw new Error('Invalid portable destination/root component');
    }
  }
}

export async function inspectDestination(root: string, target: string, absent: boolean): Promise<void> {
  const rel = relative(root, target);
  validateComponents(rel);
  if (!inside(root, target) || rel === '') throw new Error('CMS destination escapes project');
  await safePath(root);
  let current = root;
  const components = rel.split(sep);
  for (const [index, component] of components.entries()) {
    // eslint-disable-next-line no-await-in-loop -- inspect actual entries to reject aliases on every platform
    const entries = await readdir(current);
    const matches = entries.filter((entry) => pathKey(entry) === pathKey(component));
    if (!matches.length) return;
    if (matches.length !== 1 || matches[0] !== component) throw new Error('Destination case or NFKC alias');
    current = join(current, component);
    // eslint-disable-next-line no-await-in-loop -- reject links/reparse ancestors before writes
    await safePath(current);
    if (absent && index === components.length - 1) throw new Error('CMS destination already exists');
    // eslint-disable-next-line no-await-in-loop -- every existing parent must be a regular directory
    if (!(await lstat(current)).isDirectory()) throw new Error('CMS destination ancestor is not a directory');
  }
}
async function createDestination(root: string, target: string, exclusive: boolean): Promise<void> {
  const components = relative(root, target).split(sep);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    // eslint-disable-next-line no-await-in-loop -- revalidate all parents immediately before mkdir
    await inspectDestination(root, current, exclusive && index === components.length - 1);
    try {
      // eslint-disable-next-line no-await-in-loop -- nonrecursive creation, never merge a workspace
      await mkdir(current);
    } catch (error) {
      if (!(object(error) && error.code === 'EEXIST') || (exclusive && index === components.length - 1)) throw error;
      // eslint-disable-next-line no-await-in-loop -- raced-in ancestors must be checked before use
      await inspectDestination(root, current, false);
    }
  }
}

function negotiate(info: CmsInfoResultV2, apiVersion: string): void {
  if (
    apiVersion !== '67.0' ||
    info.api.defaultVersion !== apiVersion ||
    !info.api.testedVersions.includes(apiVersion)
  ) {
    throw new Error('CMS retrieval supports only the advertised and tested default API 67.0');
  }
  if (
    !info.contracts.commandResults.workspaceExportSet.some((version) => version.startsWith('1.')) ||
    !info.contracts.packageManifests.workspaceExport.some((version) => version.startsWith('1.')) ||
    !info.contracts.compatibility['workspaceExportSet@1'].workspaceExportManifestMajors.includes(1) ||
    !info.contracts.embeddedResults.externalReferenceCorrelations.includes(CMS_CORRELATION_CONTRACT)
  ) {
    throw new Error('CMS bulk export and correlation contracts are unsupported');
  }
  for (const [id, contract] of [
    [CMS_BULK_EXPORT_CAPABILITY, `${CMS_EXPORT_CONTRACT}@1`],
    [CMS_CORRELATION_CAPABILITY, CMS_CORRELATION_CONTRACT],
  ]) {
    const matches = info.capabilities.filter((capability) => capability.id === id);
    if (matches.length !== 1 || matches[0].contract !== contract || matches[0].state === 'unavailable') {
      throw new Error(`CMS retrieval requires available capability ${id}`);
    }
  }
}

function bindProvider(
  envelope: CmsEnvelope<CmsExportResult>,
  info: CmsInfoResultV2,
  apiVersion: string,
  nullEvidence: boolean
): void {
  if (
    envelope.metadata.plugin.version !== info.plugin.version ||
    envelope.provenance.pluginVersion !== info.plugin.version
  ) {
    throw new Error('CMS export provider version binding mismatch');
  }
  if (!info.contracts.commandResults.workspaceExportSet.includes(envelope.contractVersion)) {
    throw new Error('CMS export result version was not advertised');
  }
  if (
    envelope.result?.workspaces.some(
      (row) =>
        row.artifact !== null &&
        (!info.contracts.packageManifests.workspaceExport.includes(row.artifact.manifestContractVersion) ||
          !info.contracts.compatibility['workspaceExportSet@1'].workspaceExportManifestMajors.includes(
            Number(row.artifact.manifestContractVersion.split('.')[0])
          ))
    )
  ) {
    throw new Error('CMS export manifest version was not advertised or compatible');
  }
  if (envelope.metadata.apiVersion !== apiVersion && !(nullEvidence && envelope.metadata.apiVersion === null)) {
    throw new Error('CMS export API binding mismatch');
  }
}

/** Validate the aggregate retrieval context without narrowing standalone CMS acceptance. */
export async function validateRetrievalProject(projectRoot: string): Promise<string[]> {
  const roots = await validateProject(projectRoot);
  const root = resolve(projectRoot);
  const project = JSON.parse(await readFile(join(root, 'sfdx-project.json'), 'utf8')) as {
    packageDirectories: Array<{ default?: unknown }>;
  };
  if (project.packageDirectories.filter((entry) => entry.default === true).length !== 1) {
    throw new Error('Aggregate retrieval requires exactly one default native package root');
  }
  for (const [index, path] of roots.entries()) {
    if (roots.some((other, otherIndex) => otherIndex !== index && overlaps(path, other))) {
      throw new Error('Aggregate native package roots overlap or alias');
    }
  }
  for (const name of ['cms', 'data', 'mcnext']) {
    const output = join(root, name);
    if (roots.some((path) => overlaps(path, output))) {
      throw new Error('Aggregate output overlaps native package roots');
    }
    // eslint-disable-next-line no-await-in-loop -- validate all existing output ancestors before provider effects
    await inspectDestination(root, output, false);
  }
  return roots;
}

async function validateProject(projectRoot: string): Promise<string[]> {
  if (!projectRoot || projectRoot.includes('\0') || !isAbsolute(projectRoot)) {
    throw new Error('Project root must be an existing absolute canonical directory');
  }
  validateComponents(projectRoot.slice(parse(projectRoot).root.length));
  const root = resolve(projectRoot);
  await safePath(root);
  if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root) {
    throw new Error('Project root must be a regular canonical directory');
  }
  const configuration = join(root, 'sfdx-project.json');
  await safePath(configuration);
  if (!(await lstat(configuration)).isFile() || (await realpath(configuration)) !== configuration) {
    throw new Error('Root sfdx-project.json must be a regular canonical file');
  }
  const project: unknown = JSON.parse(await readFile(configuration, 'utf8'));
  if (!object(project) || !Array.isArray(project.packageDirectories) || !project.packageDirectories.length) {
    throw new Error('Malformed project packageDirectories');
  }
  const roots: string[] = [];
  for (const entry of project.packageDirectories as unknown[]) {
    if (
      !object(entry) ||
      typeof entry.path !== 'string' ||
      !entry.path ||
      /[\0:*?]/u.test(entry.path) ||
      isAbsolute(entry.path) ||
      entry.path.split(/[\\/]/u).includes('..')
    ) {
      throw new Error('Malformed native package root');
    }
    validateComponents(entry.path);
    const path = resolve(root, entry.path);
    if (!inside(root, path)) throw new Error('Native package root escapes project');
    // eslint-disable-next-line no-await-in-loop -- every configured native root is validated before use
    await safePath(path);
    // eslint-disable-next-line no-await-in-loop -- reject missing/non-directory configured roots
    if (!(await lstat(path)).isDirectory()) throw new Error('Native package root is not a directory');
    // eslint-disable-next-line no-await-in-loop -- inspect configured root spelling and aliases
    await inspectDestination(root, path, false);
    roots.push(path);
  }
  return roots;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function safePath(target: string): Promise<void> {
  // Node does not expose every Windows reparse type; reject those through the OS too.
  if (process.platform === 'win32') {
    await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
      $ErrorActionPreference = 'Stop'
      $current = $env:SF_MCNEXT_CMS_PROJECT_PATH
      while ($true) {
        $item = Get-Item -LiteralPath $current -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Project reparse point rejected' }
        $parent = [IO.Path]::GetDirectoryName($current)
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
      }
    `,
      ],
      { env: { ...process.env, SF_MCNEXT_CMS_PROJECT_PATH: target }, windowsHide: true }
    );
  }
  let current = target;
  while (current !== '') {
    // eslint-disable-next-line no-await-in-loop -- inspect every project/configuration ancestor before delegation
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Project ancestor link rejected');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
