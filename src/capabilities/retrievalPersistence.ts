import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeAtomicOutput } from '../filesystem/atomicOutput.js';
import type { CompletionEvidence } from './portableResolution.js';
import { portableRetrievalResult, type Phase5Result } from './phase5Results.js';
import { assertPortableIdentity, assertPortablePayload, type PortableIdentity } from './contracts.js';
import {
  createResolutionCacheEntry,
  lookupServerIdentity,
  refreshResolutionCache,
  type ResolutionCache,
  type TargetedResolutionRequest,
} from './resolutionCache.js';

export const PORTABLE_RETRIEVAL_CONTRACT = 'sf-mcnext-portable-retrieval-v1' as const;
export const PORTABLE_RETRIEVAL_VERSION = '1.0.0' as const;

export type PortableRetrievalSidecar = {
  contract: typeof PORTABLE_RETRIEVAL_CONTRACT;
  version: typeof PORTABLE_RETRIEVAL_VERSION;
  portableIdentity: PortableIdentity;
  role: 'artifact-identity' | 'resolver-scope-only';
  deployableDefinition: false;
  contentHash: string;
};

export type PreparedPortableRetrieval = {
  destination: string;
  bytes: string;
  cache: ResolutionCache;
  cacheHit: boolean;
  sidecar: PortableRetrievalSidecar;
  report: Phase5Result;
};

export type PortableRetrievalPreparation = {
  projectRoot: string;
  nativeArtifactPath?: string;
  request: TargetedResolutionRequest;
  cache: ResolutionCache;
  load: (request: TargetedResolutionRequest) => Promise<TargetedResolutionRequest>;
  observedAt: string;
};

/** Validate one native retrieval root and prepare a deterministic, leak-free portable sidecar before publication. */
export async function preparePortableRetrieval(
  options: PortableRetrievalPreparation
): Promise<PreparedPortableRetrieval> {
  const portableIdentity = requestedIdentity(options.request);
  const cached = lookupServerIdentity(options.cache, portableIdentity);
  let cache = options.cache;
  const cacheHit =
    cached !== undefined &&
    options.cache.entries.some(
      (entry) =>
        canonical(entry.portableIdentity) === canonical(portableIdentity) &&
        entry.sourceHash === hashCanonical(options.request)
    );
  let completion: CompletionEvidence | undefined;

  if (!cacheHit) {
    const loaded = await options.load(options.request);
    const entry = createResolutionCacheEntry(loaded);
    completion = loaded.source.completion;
    if (canonical(entry.portableIdentity) !== canonical(portableIdentity)) {
      throw new Error('Portable retrieval resolved a different root');
    }
    cache = await refreshResolutionCache(
      options.cache,
      [options.request],
      () => Promise.resolve(loaded),
      options.observedAt
    );
    if (!lookupServerIdentity(cache, portableIdentity))
      throw new Error('Portable retrieval evidence did not produce a positive cache entry');
  }

  assertPortableIdentity(portableIdentity);
  const destination = await sidecarDestination(options.projectRoot, options.nativeArtifactPath, options.request);
  const role: PortableRetrievalSidecar['role'] =
    options.request.kind === 'Campaign' ? 'artifact-identity' : 'resolver-scope-only';
  const body = {
    contract: PORTABLE_RETRIEVAL_CONTRACT,
    version: PORTABLE_RETRIEVAL_VERSION,
    portableIdentity,
    role,
    deployableDefinition: false as const,
  };
  assertPortablePayload(body);
  const sidecar: PortableRetrievalSidecar = { ...body, contentHash: hashCanonical(body) };
  return {
    destination,
    bytes: `${canonical(sidecar, 2)}\n`,
    cache,
    cacheHit,
    sidecar,
    report: portableRetrievalResult(sidecar, cacheHit, completion),
  };
}

/** Persist a prepared portable sidecar through the established atomic output utility. */
export async function writePreparedPortableRetrieval(prepared: PreparedPortableRetrieval): Promise<void> {
  await writeAtomicOutput(prepared.destination, async ({ handle }) => {
    await handle.writeFile(prepared.bytes, 'utf8');
    await handle.close();
  });
}

/** Strictly validate the unchanged portable v1 sidecar before accepting it as input. */
export function assertPortableRetrievalSidecar(value: unknown): asserts value is PortableRetrievalSidecar {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid portable sidecar');
  const sidecar = value as Record<string, unknown>;
  const keys = ['contract', 'version', 'portableIdentity', 'role', 'deployableDefinition', 'contentHash'];
  if (Object.keys(sidecar).toSorted().join('\0') !== keys.toSorted().join('\0'))
    throw new Error('Unknown or missing portable sidecar fields');
  if (
    sidecar.contract !== PORTABLE_RETRIEVAL_CONTRACT ||
    sidecar.version !== PORTABLE_RETRIEVAL_VERSION ||
    sidecar.deployableDefinition !== false ||
    !['artifact-identity', 'resolver-scope-only'].includes(sidecar.role as string)
  )
    throw new Error('Unsupported portable sidecar contract/version/role');
  assertPortableIdentity(sidecar.portableIdentity);
  const { contentHash, ...body } = sidecar;
  if (contentHash !== hashCanonical(body)) throw new Error('Portable sidecar content hash mismatch');
  assertPortablePayload(sidecar);
}

async function sidecarDestination(
  projectRoot: string,
  nativeArtifactPath: string | undefined,
  request: TargetedResolutionRequest
): Promise<string> {
  const root = await realpath(resolve(projectRoot));
  if (request.kind === 'Data Space') {
    const apiName = safeSegment(request.source.DataSpaceApiName, 'DataSpace API name');
    return join(root, 'data360', apiName, 'portable-identity.json');
  }
  if (!nativeArtifactPath) throw new Error('Campaign native artifact path is required');
  const artifact = isAbsolute(nativeArtifactPath) ? resolve(nativeArtifactPath) : resolve(root, nativeArtifactPath);
  const packageRoots = await configuredPackageRoots(root);
  if (!packageRoots.some((packageRoot) => confined(packageRoot, artifact))) {
    throw new Error('Campaign artifact must remain in a configured Salesforce package directory');
  }
  return `${artifact}.portable.json`;
}

async function configuredPackageRoots(projectRoot: string): Promise<string[]> {
  const project: unknown = JSON.parse(await readFile(join(projectRoot, 'sfdx-project.json'), 'utf8'));
  if (typeof project !== 'object' || project === null || Array.isArray(project))
    throw new Error('Invalid Salesforce project');
  const directories = (project as { packageDirectories?: unknown }).packageDirectories;
  if (!Array.isArray(directories) || directories.length === 0)
    throw new Error('Configured packageDirectories required');
  return directories.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      typeof (entry as { path?: unknown }).path !== 'string'
    ) {
      throw new Error('Configured packageDirectories required');
    }
    const packageRoot = resolve(projectRoot, (entry as { path: string }).path);
    if (!confined(projectRoot, packageRoot)) throw new Error('Package directory escapes project root');
    return packageRoot;
  });
}

function confined(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function requestedIdentity(request: TargetedResolutionRequest): PortableIdentity {
  return request.kind === 'Campaign'
    ? { family: 'mcnext', type: 'Campaign', apiName: request.source.portableName, context: request.source.context }
    : { family: 'mcnext', type: 'Data Space', apiName: request.source.DataSpaceApiName };
}

function safeSegment(value: string, label: string): string {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`${label} is not a safe path segment`);
  }
  return value;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function canonical(value: unknown, spaces?: number): string {
  return JSON.stringify(sortJson(value), undefined, spaces);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortJson((value as Record<string, unknown>)[key])])
  );
}
