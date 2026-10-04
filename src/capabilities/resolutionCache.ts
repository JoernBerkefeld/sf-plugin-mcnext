import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { writeAtomicOutput } from '../filesystem/atomicOutput.js';
import {
  assertPortableIdentity,
  assertPortablePayload,
  assertServerIdentity,
  METADATA_CAPABILITY_CONTRACT,
  METADATA_CAPABILITY_FIXTURE_SHA256,
  type JsonValue,
  type PortableIdentity,
  type ServerIdentity,
} from './contracts.js';
import {
  resolveCampaignPortableIdentity,
  resolveDataSpacePortableIdentity,
  type CampaignResolutionInput,
  type DataSpaceResolutionInput,
} from './portableResolution.js';

export const RESOLUTION_CACHE_CONTRACT = 'sf-mcnext-targeted-resolution-cache-v1' as const;
export const RESOLUTION_CACHE_VERSION = '1.0.0' as const;
const MAX_ENTRIES = 1000;
const MAX_BYTES = 4 * 1024 * 1024;

export type ResolutionCacheScope = {
  sourceOrgId: string;
  targetOrgId: string;
  provider: 'sf-plugin-mcnext';
  apiVersion: string;
  capabilityContract: typeof METADATA_CAPABILITY_CONTRACT;
  capabilityFixtureSha256: typeof METADATA_CAPABILITY_FIXTURE_SHA256;
  declaration: { type: 'Campaign' | 'Data Space'; profile: string };
  nativeContext: Record<string, JsonValue>;
};

export type ResolutionCacheEntry = {
  portableIdentity: PortableIdentity;
  evidenceIdentity: ServerIdentity;
  sourceHash: string;
  evidenceHash: string;
  mappingHash: string;
};

export type ResolutionCache = {
  contract: typeof RESOLUTION_CACHE_CONTRACT;
  version: typeof RESOLUTION_CACHE_VERSION;
  scope: ResolutionCacheScope;
  entries: ResolutionCacheEntry[];
  contentHash: string;
  observations: Array<{ mappingHash: string; observedAt: string }>;
};

export type TargetedResolutionRequest =
  | { kind: 'Campaign'; source: CampaignResolutionInput }
  | { kind: 'Data Space'; source: DataSpaceResolutionInput };

export type ResolutionSourceLoader = (request: TargetedResolutionRequest) => Promise<TargetedResolutionRequest>;

/** Create an empty exact-scope cache. */
export function createResolutionCache(scope: ResolutionCacheScope): ResolutionCache {
  assertScope(scope);
  return finalize(scope, [], []);
}

/** Convert only fully validated native resolution evidence into a positive cache entry. */
export function createResolutionCacheEntry(request: TargetedResolutionRequest): ResolutionCacheEntry {
  const resolved =
    request.kind === 'Campaign'
      ? resolveCampaignPortableIdentity(request.source)
      : resolveDataSpacePortableIdentity(request.source);
  const sourceHash = hashCanonical(request);
  const evidenceHash = hashCanonical(resolved.evidence);
  const mapping = {
    portableIdentity: resolved.portableIdentity,
    evidenceIdentity: resolved.evidenceIdentity,
    sourceHash,
    evidenceHash,
  };
  return { ...mapping, mappingHash: hashCanonical(mapping) };
}

/** Resolve a portable identity to its exact typed server evidence. */
export function lookupServerIdentity(
  cache: ResolutionCache,
  portableIdentity: PortableIdentity
): ServerIdentity | undefined {
  assertResolutionCache(cache, cache.scope);
  const key = canonical(portableIdentity);
  return cache.entries.find((entry) => canonical(entry.portableIdentity) === key)?.evidenceIdentity;
}

/** Resolve exact typed server evidence back to its portable identity. */
export function lookupPortableIdentity(
  cache: ResolutionCache,
  evidenceIdentity: ServerIdentity
): PortableIdentity | undefined {
  assertResolutionCache(cache, cache.scope);
  const key = canonical(evidenceIdentity);
  return cache.entries.find((entry) => canonical(entry.evidenceIdentity) === key)?.portableIdentity;
}

/** Refresh only requested roots; unchanged source hashes avoid resolver calls and failures never retain stale positives. */
export async function refreshResolutionCache(
  cache: ResolutionCache,
  requests: TargetedResolutionRequest[],
  loader: ResolutionSourceLoader,
  observedAt: string
): Promise<ResolutionCache> {
  assertResolutionCache(cache, cache.scope);
  requireTimestamp(observedAt);
  const byPortable = new Map(cache.entries.map((entry) => [portableKey(entry.portableIdentity), entry]));
  const observations = new Map(cache.observations.map((item) => [item.mappingHash, item.observedAt]));

  for (const request of requests) {
    assertRequestMatchesScope(request, cache.scope);
    const requestedPortable = requestPortableIdentity(request);
    const key = portableKey(requestedPortable);
    const requestedSourceHash = hashCanonical(request);
    const current = byPortable.get(key);
    if (current?.sourceHash === requestedSourceHash) continue;
    byPortable.delete(key);
    try {
      // eslint-disable-next-line no-await-in-loop -- targeted refresh intentionally limits one exact root at a time
      const loaded = await loader(request);
      assertRequestMatchesScope(loaded, cache.scope);
      const refreshed = createResolutionCacheEntry(loaded);
      if (portableKey(refreshed.portableIdentity) !== key)
        throw new Error('targeted refresh returned a different root');
      byPortable.set(key, refreshed);
      observations.set(refreshed.mappingHash, observedAt);
    } catch {
      // Absence and failed/partial evidence are not negative facts; the exact stale positive remains removed.
    }
  }

  return finalize(
    cache.scope,
    [...byPortable.values()],
    [...observations].map(([mappingHash, time]) => ({ mappingHash, observedAt: time }))
  );
}

/** Persist a validated cache through atomic replacement inside an explicitly confined root. */
export async function writeResolutionCache(
  cacheRoot: string,
  destination: string,
  cache: ResolutionCache
): Promise<void> {
  assertResolutionCache(cache, cache.scope);
  await assertConfinedPath(cacheRoot, destination);
  const bytes = serializeResolutionCache(cache);
  await writeAtomicOutput(destination, async ({ handle }) => {
    await handle.writeFile(bytes, 'utf8');
    await handle.close();
  });
}

/** Read and strictly validate an exact-scope cache. */
export async function readResolutionCache(
  cacheRoot: string,
  destination: string,
  expectedScope: ResolutionCacheScope
): Promise<ResolutionCache> {
  await assertConfinedPath(cacheRoot, destination);
  const bytes = await readFile(destination, 'utf8');
  if (Buffer.byteLength(bytes, 'utf8') > MAX_BYTES) throw new Error('resolution cache exceeds byte bound');
  const value: unknown = JSON.parse(bytes);
  assertResolutionCache(value, expectedScope);
  return value;
}

export function serializeResolutionCache(cache: ResolutionCache): string {
  assertResolutionCache(cache, cache.scope);
  return `${canonical(cache, 2)}\n`;
}

/** Strictly validate schema, scope, hashes, portable separation, uniqueness, conflicts, and bounds. */
export function assertResolutionCache(
  value: unknown,
  expectedScope: ResolutionCacheScope
): asserts value is ResolutionCache {
  const cache = strictRecord(
    value,
    ['contract', 'version', 'scope', 'entries', 'contentHash', 'observations'],
    'cache'
  );
  if (cache.contract !== RESOLUTION_CACHE_CONTRACT || cache.version !== RESOLUTION_CACHE_VERSION)
    throw new Error('resolution cache contract/version mismatch');
  assertScope(cache.scope);
  if (canonical(cache.scope) !== canonical(expectedScope)) throw new Error('resolution cache scope mismatch');
  if (!Array.isArray(cache.entries) || cache.entries.length > MAX_ENTRIES)
    throw new Error('resolution cache entry bound exceeded');
  if (!Array.isArray(cache.observations) || cache.observations.length > MAX_ENTRIES)
    throw new Error('resolution cache observation bound exceeded');

  const portable = new Map<string, string>();
  const evidence = new Map<string, string>();
  const mappingHashes = new Set<string>();
  for (const item of cache.entries) {
    const entry = strictRecord(
      item,
      ['portableIdentity', 'evidenceIdentity', 'sourceHash', 'evidenceHash', 'mappingHash'],
      'entry'
    );
    assertPortableIdentity(entry.portableIdentity);
    assertServerIdentity(entry.evidenceIdentity);
    for (const key of ['sourceHash', 'evidenceHash', 'mappingHash'] as const) requireHash(entry[key], key);
    const mapping = {
      portableIdentity: entry.portableIdentity,
      evidenceIdentity: entry.evidenceIdentity,
      sourceHash: entry.sourceHash,
      evidenceHash: entry.evidenceHash,
    };
    if (entry.mappingHash !== hashCanonical(mapping)) throw new Error('resolution cache mapping hash mismatch');
    const portableId = canonical(entry.portableIdentity);
    const evidenceId = canonical(entry.evidenceIdentity);
    if (portable.has(portableId) || evidence.has(evidenceId) || mappingHashes.has(entry.mappingHash))
      throw new Error('resolution cache duplicate/conflicting mapping');
    portable.set(portableId, evidenceId);
    evidence.set(evidenceId, portableId);
    mappingHashes.add(entry.mappingHash);
  }
  requireCanonical(cache.entries as unknown[], 'entries');

  for (const item of cache.observations) {
    const observation = strictRecord(item, ['mappingHash', 'observedAt'], 'observation');
    requireHash(observation.mappingHash, 'observation mappingHash');
    requireTimestamp(observation.observedAt);
    if (!mappingHashes.has(observation.mappingHash)) throw new Error('resolution cache observation has no mapping');
  }
  requireCanonical(cache.observations as unknown[], 'observations');
  if (
    cache.contentHash !==
    hashCanonical({ contract: cache.contract, version: cache.version, scope: cache.scope, entries: cache.entries })
  ) {
    throw new Error('resolution cache content hash mismatch');
  }
}

function finalize(
  scope: ResolutionCacheScope,
  entries: ResolutionCacheEntry[],
  observations: ResolutionCache['observations']
): ResolutionCache {
  const sortedEntries = [...entries].sort((left, right) => (canonical(left) < canonical(right) ? -1 : 1));
  const validMappings = new Set(sortedEntries.map((entry) => entry.mappingHash));
  const sortedObservations = observations
    .filter((item) => validMappings.has(item.mappingHash))
    .sort((left, right) => (canonical(left) < canonical(right) ? -1 : 1));
  const deterministic = {
    contract: RESOLUTION_CACHE_CONTRACT,
    version: RESOLUTION_CACHE_VERSION,
    scope,
    entries: sortedEntries,
  };
  const cache: ResolutionCache = {
    ...deterministic,
    contentHash: hashCanonical(deterministic),
    observations: sortedObservations,
  };
  assertResolutionCache(cache, scope);
  return cache;
}

function assertScope(value: unknown): asserts value is ResolutionCacheScope {
  const scope = strictRecord(
    value,
    [
      'sourceOrgId',
      'targetOrgId',
      'provider',
      'apiVersion',
      'capabilityContract',
      'capabilityFixtureSha256',
      'declaration',
      'nativeContext',
    ],
    'scope'
  );
  requireOrgId(scope.sourceOrgId, 'source org');
  requireOrgId(scope.targetOrgId, 'target org');
  if (
    scope.provider !== 'sf-plugin-mcnext' ||
    scope.capabilityContract !== METADATA_CAPABILITY_CONTRACT ||
    scope.capabilityFixtureSha256 !== METADATA_CAPABILITY_FIXTURE_SHA256
  )
    throw new Error('resolution cache provider/fixture mismatch');
  if (typeof scope.apiVersion !== 'string' || !/^\d+\.\d+$/.test(scope.apiVersion))
    throw new Error('resolution cache API version is invalid');
  const declaration = strictRecord(scope.declaration, ['type', 'profile'], 'scope declaration');
  if (!['Campaign', 'Data Space'].includes(declaration.type as string) || typeof declaration.profile !== 'string')
    throw new Error('resolution cache declaration is invalid');
  if (typeof scope.nativeContext !== 'object' || scope.nativeContext === null || Array.isArray(scope.nativeContext))
    throw new Error('resolution cache native context is invalid');
  assertPortablePayload(scope.nativeContext);
}

function assertRequestMatchesScope(request: TargetedResolutionRequest, scope: ResolutionCacheScope): void {
  if (request.kind !== scope.declaration.type) throw new Error('targeted resolution type does not match cache scope');
  const expectedProfile = request.kind === 'Campaign' ? 'relationship-free-scalar-resolver' : 'scope-identity-resolver';
  if (scope.declaration.profile !== expectedProfile)
    throw new Error('targeted resolution profile does not match cache scope');
}

async function assertConfinedPath(rootPath: string, destination: string): Promise<void> {
  const root = await realpath(rootPath);
  const absolute = resolve(destination);
  const rel = relative(root, absolute);
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('resolution cache path escapes confined root');
  let current = dirname(absolute);
  while (current !== root) {
    // eslint-disable-next-line no-await-in-loop -- every existing ancestor must be checked in path order
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error('resolution cache path contains a link');
    const next = dirname(current);
    if (next === current) throw new Error('resolution cache path escapes confined root');
    current = next;
  }
}

function requestPortableIdentity(request: TargetedResolutionRequest): PortableIdentity {
  const portableIdentity: PortableIdentity =
    request.kind === 'Campaign'
      ? { family: 'mcnext', type: 'Campaign', apiName: request.source.portableName, context: request.source.context }
      : { family: 'mcnext', type: 'Data Space', apiName: request.source.DataSpaceApiName };
  assertPortableIdentity(portableIdentity);
  return portableIdentity;
}
function portableKey(identity: PortableIdentity): string {
  return canonical(identity);
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
function strictRecord(value: unknown, keys: string[], label: string, required = keys): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`resolution cache ${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.some((key) => !keys.includes(key)) || required.some((key) => !actual.includes(key)))
    throw new Error(`resolution cache ${label} fields are invalid`);
  return value as Record<string, unknown>;
}
function requireHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(`resolution cache ${label} is invalid`);
}
function requireOrgId(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^00D[A-Za-z0-9]{15}$/.test(value))
    throw new Error(`resolution cache ${label} ID is invalid`);
}
function requireTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value)
    throw new Error('resolution cache observation timestamp is invalid');
}
function requireCanonical(values: unknown[], label: string): void {
  const serialized = values.map((item) => canonical(item));
  if (serialized.some((item, index) => item !== [...serialized].sort()[index]))
    throw new Error(`resolution cache ${label} are not canonically ordered`);
}
