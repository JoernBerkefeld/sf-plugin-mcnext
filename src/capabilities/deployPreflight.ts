import { createHash } from 'node:crypto';
import {
  CMS_PLUGIN_NAME,
  validateCmsExport,
  validateCmsRegistryInfo,
  type CmsRegistryDeclaration,
} from '../cms/contracts.js';
import type { ValidatedCmsPackage } from '../cms/packageIntegrity.js';
import {
  planDependencyGraph,
  portableIdentityKey,
  type DependencyGraphPlan,
  type DependencyGraphEdgeInput,
} from './dependencyGraph.js';
import {
  assertCapabilityDeclaration,
  assertDependencyDescriptor,
  assertPortableIdentity,
  assertServerIdentity,
  type CapabilityDeclaration,
  type DependencyDescriptor,
  type JsonValue,
  type PortableIdentity,
  type ServerIdentity,
} from './contracts.js';
import {
  assertResolutionCache,
  createResolutionCacheEntry,
  type TargetedResolutionRequest,
  type ResolutionCache,
  type ResolutionCacheScope,
} from './resolutionCache.js';
import { lookupMcnCapability } from './registry.js';
import {
  PORTABLE_RETRIEVAL_CONTRACT,
  PORTABLE_RETRIEVAL_VERSION,
  assertPortableRetrievalSidecar,
  type PortableRetrievalSidecar,
} from './retrievalPersistence.js';

export const DEPLOY_PREFLIGHT_CONTRACT = 'sf-mcnext-deploy-preflight-v1' as const;
export const DEPLOY_PREFLIGHT_VERSION = '1.0.0' as const;

export type SelectedPortableSidecar = {
  path: string;
  bytesSha256: string;
  bytes: string;
  sidecar: PortableRetrievalSidecar;
};

export type DeployOperationRequest = {
  operationId: string;
  portableIdentity: PortableIdentity;
  sidecarPath?: string;
  sourceHash: string;
  sourceBytes: string;
  requestHash: string;
  requestBytes: string;
  dependencies: DependencyDescriptor[];
  optionalDependencyOmissions?: Array<{ descriptorHash: string; semanticsEvidence: string }>;
  dependencySources?: TargetedResolutionRequest[];
};

export type ExplicitResolutionMapping = {
  portableIdentity: PortableIdentity;
  serverIdentity: ServerIdentity;
  targetContext: Record<string, JsonValue>;
  sourceHash: string;
};

export type CmsPreflightInput = {
  registryInfo: unknown;
  exportEnvelope: unknown;
  validatedPackage: ValidatedCmsPackage;
  workspaceId: string;
  manifestSha256: string;
};

export type DeployRouteRequest = {
  routeId: string;
  providerVersion: string;
  declaration: CapabilityDeclaration;
  targetContext: Record<string, JsonValue>;
  operations: DeployOperationRequest[];
  sidecars: SelectedPortableSidecar[];
  packageManifestSha256?: string;
  packageManifestBytes?: string;
  explicitMappings?: ExplicitResolutionMapping[];
  cache?: { value: ResolutionCache; expectedScope: ResolutionCacheScope };
  cms?: CmsPreflightInput;
  transport?: { salesforce: () => unknown; cms: () => unknown };
};

export type ResolutionProvenance =
  | { method: 'package'; operationId: string; operationHash: string }
  | { method: 'mapping'; mappingHash: string; serverIdentity: ServerIdentity }
  | { method: 'cache'; mappingHash: string; serverIdentity: ServerIdentity };

export type PlannedDependency = {
  descriptorHash: string;
  kind: string;
  required: boolean;
  resolution: ResolutionProvenance | null;
  blockedReason?: string;
  omission?: { semanticsEvidence: string };
};

export type PlannedDeployOperation = {
  operationId: string;
  portableIdentity: PortableIdentity;
  sourceHash: string;
  requestHash: string;
  sidecarHash?: string;
  packageManifestSha256?: string;
  evidenceHashes: string[];
  dependencies: PlannedDependency[];
  operationHash: string;
  ready: boolean;
  blockedReasons: string[];
};

export type DeployRoutePlan = {
  contract: typeof DEPLOY_PREFLIGHT_CONTRACT;
  version: typeof DEPLOY_PREFLIGHT_VERSION;
  routeId: string;
  status: 'ready' | 'blocked';
  targetContextHash: string;
  registryHash?: string;
  manifestSha256?: string;
  packageEvidenceHash?: string;
  operations: PlannedDeployOperation[];
  graph?: DependencyGraphPlan;
  blockedReasons: string[];
  planHash: string;
  zeroMutation: true;
};

export type DeployPreflightReport = {
  contract: typeof DEPLOY_PREFLIGHT_CONTRACT;
  version: typeof DEPLOY_PREFLIGHT_VERSION;
  routes: DeployRoutePlan[];
  reportHash: string;
  zeroMutation: true;
};

/** Build deterministic, route-isolated deploy plans without invoking any provider transport. */
export function planDeployPreflight(routes: DeployRouteRequest[]): DeployPreflightReport {
  const routeIds = routes.map((route) => route.routeId);
  if (routeIds.some((routeId) => !routeId) || new Set(routeIds).size !== routeIds.length) {
    throw new Error('Deploy preflight route IDs must be non-empty and unique');
  }

  const plans = routes
    .map((route) => planRouteSafely(route))
    .sort((left, right) => left.routeId.localeCompare(right.routeId));
  const body = {
    contract: DEPLOY_PREFLIGHT_CONTRACT,
    version: DEPLOY_PREFLIGHT_VERSION,
    routes: plans,
    zeroMutation: true as const,
  };
  return { ...body, reportHash: hashCanonical(body) };
}

function planRouteSafely(route: DeployRouteRequest): DeployRoutePlan {
  try {
    return planRoute(route);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown deploy preflight failure';
    const body = {
      contract: DEPLOY_PREFLIGHT_CONTRACT,
      version: DEPLOY_PREFLIGHT_VERSION,
      routeId: route.routeId,
      status: 'blocked' as const,
      targetContextHash: hashCanonical(route.targetContext),
      operations: [],
      blockedReasons: [reason],
      zeroMutation: true as const,
    };
    return { ...body, planHash: hashCanonical(body) };
  }
}

function planRoute(route: DeployRouteRequest): DeployRoutePlan {
  assertCapabilityDeclaration(route.declaration);
  requireVersionInRange(
    route.providerVersion,
    route.declaration.providerContract.minVersion,
    route.declaration.providerContract.maxVersion
  );
  if (route.declaration.identity.provider !== route.declaration.providerContract.name) {
    throw new Error('Deploy preflight provider declaration is incompatible');
  }
  if (!route.declaration.operations.includes('resolve')) {
    throw new Error('Deploy preflight declaration does not permit resolution');
  }

  const targetContextHash = hashCanonical(route.targetContext);
  if (route.packageManifestSha256 !== undefined) {
    requireBytesHash(route.packageManifestBytes, route.packageManifestSha256, 'package manifest');
  } else if (route.packageManifestBytes !== undefined) {
    throw new Error('Package manifest bytes require a selected hash');
  }
  if (route.declaration.identity.provider !== CMS_PLUGIN_NAME) validateNativeDeclaration(route.declaration);
  const sidecars = validateSidecars(route.sidecars);
  const packageOperations = indexPackageOperations(route.operations);
  const mappings = validateMappings(route.explicitMappings ?? [], route.targetContext);
  const cache = validateCache(route.cache, route.targetContext, route.declaration);
  const cmsBinding = route.declaration.identity.provider === CMS_PLUGIN_NAME ? validateCmsRoute(route) : undefined;
  if (route.declaration.identity.provider !== CMS_PLUGIN_NAME && route.cms !== undefined) {
    throw new Error('CMS contracts cannot be attached to a native route');
  }

  const operations = route.operations
    .map((operation) => planOperation(operation, route, sidecars, packageOperations, mappings, cache))
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
  const graph = planDependencyGraph(
    operations.map((operation) => {
      const selected = route.operations.find((item) => item.operationId === operation.operationId)!;
      return {
        portableIdentity: operation.portableIdentity,
        blockedReasons: operation.blockedReasons,
        dependencies: selected.dependencies.map((descriptor): DependencyGraphEdgeInput => {
          const planned = operation.dependencies.find((item) => item.descriptorHash === hashCanonical(descriptor))!;
          const resolution: DependencyGraphEdgeInput['resolution'] =
            planned.omission !== undefined
              ? { kind: 'omitted', semanticsEvidence: planned.omission.semanticsEvidence }
              : planned.resolution === null
              ? { kind: 'unresolved', reason: planned.blockedReason! }
              : { kind: planned.resolution.method === 'package' ? 'package' : 'target' };
          return { descriptor, resolution };
        }),
      };
    })
  );
  for (const operation of operations) {
    const node = graph.nodes.find((item) => item.key === identityKey(operation.portableIdentity))!;
    operation.ready = node.ready;
    operation.blockedReasons = node.blockedReasons;
  }
  const blockedReasons = operations.flatMap((operation) =>
    operation.blockedReasons.map((reason) => `${operation.operationId}: ${reason}`)
  );
  const body = {
    contract: DEPLOY_PREFLIGHT_CONTRACT,
    version: DEPLOY_PREFLIGHT_VERSION,
    routeId: route.routeId,
    status: blockedReasons.length === 0 ? ('ready' as const) : ('blocked' as const),
    targetContextHash,
    ...(cmsBinding === undefined
      ? {}
      : {
          registryHash: cmsBinding.registryHash,
          manifestSha256: cmsBinding.manifestSha256,
          packageEvidenceHash: cmsBinding.packageEvidenceHash,
        }),
    operations,
    graph,
    blockedReasons,
    zeroMutation: true as const,
  };
  return { ...body, planHash: hashCanonical(body) };
}

function planOperation(
  operation: DeployOperationRequest,
  route: DeployRouteRequest,
  sidecars: Map<string, SelectedPortableSidecar>,
  packageOperations: Map<string, DeployOperationRequest[]>,
  mappings: Map<string, ExplicitResolutionMapping>,
  cache: ResolutionCache | undefined
): PlannedDeployOperation {
  if (!operation.operationId) throw new Error('Deploy operation ID must not be empty');
  assertPortableIdentity(operation.portableIdentity);
  requireBytesHash(operation.sourceBytes, operation.sourceHash, 'operation source');
  requireBytesHash(operation.requestBytes, operation.requestHash, 'operation request');
  const sources = new Map<string, ReturnType<typeof createResolutionCacheEntry>>();
  for (const request of operation.dependencySources ?? []) {
    const entry = createResolutionCacheEntry(request);
    const key = identityKey(entry.portableIdentity);
    if (sources.has(key)) throw new Error('Dependency source evidence must be unique');
    sources.set(key, entry);
  }

  const sidecar = operation.sidecarPath === undefined ? undefined : sidecars.get(operation.sidecarPath);
  const blockedReasons: string[] = [];
  if (operation.sidecarPath !== undefined && sidecar === undefined)
    blockedReasons.push('selected portable sidecar is missing');
  if (sidecar !== undefined && canonical(sidecar.sidecar.portableIdentity) !== canonical(operation.portableIdentity)) {
    blockedReasons.push('selected portable sidecar identity does not match operation');
  }

  if (
    operation.portableIdentity.family !== route.declaration.identity.family ||
    operation.portableIdentity.type !== route.declaration.identity.type
  ) {
    blockedReasons.push(
      `Unavailable provider/type for selected route: ${operation.portableIdentity.family}/${operation.portableIdentity.type}`
    );
  }
  const omissions = new Map<string, string>();
  for (const omission of operation.optionalDependencyOmissions ?? []) {
    requireHash(omission.descriptorHash, 'optional omission descriptor hash');
    const descriptor = operation.dependencies.find((item) => hashCanonical(item) === omission.descriptorHash);
    if (
      descriptor === undefined ||
      descriptor.required ||
      !omission.semanticsEvidence.trim() ||
      omissions.has(omission.descriptorHash)
    ) {
      throw new Error('Only unique semantics-evidenced optional references may be omitted');
    }
    omissions.set(omission.descriptorHash, omission.semanticsEvidence);
  }
  const dependencies = operation.dependencies
    .map((descriptor) => {
      assertDependencyDescriptor(descriptor);
      if (identityKey(descriptor.source) !== identityKey(operation.portableIdentity)) {
        throw new Error('Dependency source does not match owning operation identity');
      }
      const descriptorHash = hashCanonical(descriptor);
      const semanticsEvidence = omissions.get(descriptorHash);
      const planned: PlannedDependency =
        semanticsEvidence === undefined
          ? descriptor.target.family !== route.declaration.identity.family ||
            descriptor.target.type !== route.declaration.identity.type
            ? blockedDependency(
                descriptorHash,
                descriptor,
                `Unavailable provider/type for selected route: ${descriptor.target.family}/${descriptor.target.type}`
              )
            : resolveDependency(
                descriptor,
                packageOperations,
                mappings,
                cache,
                sources.get(identityKey(descriptor.target))
              )
          : {
              descriptorHash,
              kind: descriptor.kind,
              required: false,
              resolution: null,
              omission: { semanticsEvidence },
            };
      if (planned.blockedReason !== undefined) blockedReasons.push(planned.blockedReason);
      return planned;
    })
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
  const evidenceHashes = dependencies
    .flatMap((dependency) => (dependency.resolution === null ? [] : [hashCanonical(dependency.resolution)]))
    .sort();
  const binding = {
    operationId: operation.operationId,
    portableIdentity: operation.portableIdentity,
    sourceHash: operation.sourceHash,
    requestHash: operation.requestHash,
    ...(sidecar === undefined ? {} : { sidecarHash: sidecar.bytesSha256 }),
    ...(route.packageManifestSha256 === undefined ? {} : { packageManifestSha256: route.packageManifestSha256 }),
    evidenceHashes,
    dependencies,
  };
  return {
    ...binding,
    operationHash: hashCanonical(binding),
    ready: blockedReasons.length === 0,
    blockedReasons: [...new Set(blockedReasons)].sort(),
  };
}

function resolveDependency(
  descriptor: DependencyDescriptor,
  packageOperations: Map<string, DeployOperationRequest[]>,
  mappings: Map<string, ExplicitResolutionMapping>,
  cache: ResolutionCache | undefined,
  expectedSource: ReturnType<typeof createResolutionCacheEntry> | undefined
): PlannedDependency {
  const descriptorHash = hashCanonical(descriptor);
  const packageMatches = packageOperations.get(identityKey(descriptor.target)) ?? [];
  if (packageMatches.length === 1) {
    const match = packageMatches[0];
    return {
      descriptorHash,
      kind: descriptor.kind,
      required: descriptor.required,
      resolution: {
        method: 'package',
        operationId: match.operationId,
        operationHash: hashCanonical({
          ...match,
          sourceBytes: undefined,
          requestBytes: undefined,
          dependencies: match.dependencies.toSorted((left, right) => canonical(left).localeCompare(canonical(right))),
          optionalDependencyOmissions: (match.optionalDependencyOmissions ?? []).toSorted((left, right) =>
            canonical(left).localeCompare(canonical(right))
          ),
          dependencySources: (match.dependencySources ?? []).toSorted((left, right) =>
            canonical(left).localeCompare(canonical(right))
          ),
        }),
      },
    };
  }
  if (packageMatches.length > 1) {
    return blockedDependency(descriptorHash, descriptor, 'ambiguous package dependency');
  }
  if (descriptor.resolution === 'package') {
    return blockedDependency(descriptorHash, descriptor, 'missing package dependency');
  }

  const mapping = mappings.get(identityKey(descriptor.target));
  if (mapping !== undefined) {
    if (expectedSource === undefined || mapping.sourceHash !== expectedSource.sourceHash) {
      return blockedDependency(
        descriptorHash,
        descriptor,
        'explicit mapping source hash mismatch or missing dependency source evidence'
      );
    }
    if (
      descriptor.evidence !== undefined &&
      canonical(descriptor.evidence.serverIdentity) !== canonical(mapping.serverIdentity)
    ) {
      return blockedDependency(descriptorHash, descriptor, 'explicit mapping evidence mismatch');
    }
    return {
      descriptorHash,
      kind: descriptor.kind,
      required: descriptor.required,
      resolution: { method: 'mapping', mappingHash: hashCanonical(mapping), serverIdentity: mapping.serverIdentity },
    };
  }

  if (cache !== undefined) {
    const cacheEntry = cache.entries.find(
      (entry) => identityKey(entry.portableIdentity) === identityKey(descriptor.target)
    );
    if (cacheEntry !== undefined) {
      if (
        expectedSource === undefined ||
        cacheEntry.sourceHash !== expectedSource.sourceHash ||
        cacheEntry.evidenceHash !== expectedSource.evidenceHash
      ) {
        return blockedDependency(descriptorHash, descriptor, 'stale cache source evidence');
      }
      if (
        descriptor.evidence !== undefined &&
        canonical(descriptor.evidence.serverIdentity) !== canonical(cacheEntry.evidenceIdentity)
      ) {
        return blockedDependency(descriptorHash, descriptor, 'stale cache evidence');
      }
      return {
        descriptorHash,
        kind: descriptor.kind,
        required: descriptor.required,
        resolution: {
          method: 'cache',
          mappingHash: cacheEntry.mappingHash,
          serverIdentity: cacheEntry.evidenceIdentity,
        },
      };
    }
  }
  return blockedDependency(descriptorHash, descriptor, 'missing exact target dependency evidence');
}

function blockedDependency(
  descriptorHash: string,
  descriptor: DependencyDescriptor,
  reason: string
): PlannedDependency {
  return {
    descriptorHash,
    kind: descriptor.kind,
    required: descriptor.required,
    resolution: null,
    blockedReason: reason,
  };
}

function validateSidecars(sidecars: SelectedPortableSidecar[]): Map<string, SelectedPortableSidecar> {
  const result = new Map<string, SelectedPortableSidecar>();
  for (const selected of sidecars) {
    if (!selected.path || result.has(selected.path)) throw new Error('Selected portable sidecar paths must be unique');
    requireBytesHash(selected.bytes, selected.bytesSha256, 'selected sidecar byte');
    const sidecar = selected.sidecar;
    if (canonical(JSON.parse(selected.bytes) as unknown) !== canonical(sidecar)) {
      throw new Error('Selected portable sidecar bytes do not match selected object');
    }
    assertPortableRetrievalSidecar(sidecar);
    if (!['artifact-identity', 'resolver-scope-only'].includes(sidecar.role)) {
      throw new Error('Selected portable sidecar role is incompatible');
    }
    if (
      sidecar.contract !== PORTABLE_RETRIEVAL_CONTRACT ||
      sidecar.version !== PORTABLE_RETRIEVAL_VERSION ||
      sidecar.deployableDefinition !== false
    ) {
      throw new Error('Selected portable sidecar contract is incompatible');
    }
    assertPortableIdentity(sidecar.portableIdentity);
    const content = {
      contract: sidecar.contract,
      version: sidecar.version,
      portableIdentity: sidecar.portableIdentity,
      role: sidecar.role,
      deployableDefinition: sidecar.deployableDefinition,
    };
    if (sidecar.contentHash !== hashCanonical(content))
      throw new Error('Selected portable sidecar content hash mismatch');
    result.set(selected.path, selected);
  }
  return result;
}

function indexPackageOperations(operations: DeployOperationRequest[]): Map<string, DeployOperationRequest[]> {
  const operationIds = new Set<string>();
  const result = new Map<string, DeployOperationRequest[]>();
  for (const operation of operations) {
    if (!operation.operationId || operationIds.has(operation.operationId))
      throw new Error('Deploy operation IDs must be unique');
    operationIds.add(operation.operationId);
    assertPortableIdentity(operation.portableIdentity);
    requireBytesHash(operation.sourceBytes, operation.sourceHash, 'operation source');
    requireBytesHash(operation.requestBytes, operation.requestHash, 'operation request');
    const key = identityKey(operation.portableIdentity);
    result.set(key, [...(result.get(key) ?? []), operation]);
  }
  return result;
}

function validateMappings(
  mappings: ExplicitResolutionMapping[],
  targetContext: Record<string, JsonValue>
): Map<string, ExplicitResolutionMapping> {
  const byPortable = new Map<string, ExplicitResolutionMapping>();
  const serverIdentities = new Set<string>();
  for (const mapping of mappings) {
    assertPortableIdentity(mapping.portableIdentity);
    assertServerIdentity(mapping.serverIdentity);
    requireHash(mapping.sourceHash, 'explicit mapping source hash');
    if (canonical(mapping.targetContext) !== canonical(targetContext))
      throw new Error('Explicit mapping target context mismatch');
    const portable = identityKey(mapping.portableIdentity);
    const server = canonical(mapping.serverIdentity);
    if (byPortable.has(portable) || serverIdentities.has(server))
      throw new Error('Explicit mappings must be strict one-to-one');
    byPortable.set(portable, mapping);
    serverIdentities.add(server);
  }
  return byPortable;
}

function validateCache(
  selected: DeployRouteRequest['cache'],
  targetContext: Record<string, JsonValue>,
  declaration: CapabilityDeclaration
): ResolutionCache | undefined {
  if (selected === undefined) return undefined;
  assertResolutionCache(selected.value, selected.expectedScope);
  if (
    selected.expectedScope.provider !== declaration.identity.provider ||
    selected.expectedScope.declaration.type !== declaration.identity.type ||
    selected.expectedScope.declaration.profile !== declaration.identity.profile
  ) {
    throw new Error('Resolution cache capability scope mismatch');
  }
  if (canonical(selected.expectedScope.nativeContext) !== canonical(targetContext)) {
    throw new Error('Resolution cache target context mismatch');
  }
  return selected.value;
}

function validateNativeDeclaration(declaration: CapabilityDeclaration): void {
  const result = lookupMcnCapability(declaration.identity);
  if (!result.available || canonical(result.declaration) !== canonical(declaration)) {
    throw new Error('Native capability registry declaration mismatch');
  }
}

function validateCmsRoute(route: DeployRouteRequest): {
  registryHash: string;
  manifestSha256: string;
  packageEvidenceHash: string;
} {
  if (route.cms === undefined) throw new Error('CMS route requires validated provider registry and manifest contracts');
  const registry = validateCmsRegistryInfo(route.cms.registryInfo);
  const exported = validateCmsExport(route.cms.exportEnvelope);
  const declaration = findCmsDeclaration(registry.registry.declarations, route.declaration);
  if (
    ![registry.envelope.provenance.pluginVersion, exported.provenance.pluginVersion].every(
      (version) => version === route.providerVersion
    )
  )
    throw new Error('CMS provider version provenance binding mismatch');
  requireVersionInRange(
    route.providerVersion,
    declaration.providerContract.minVersion,
    declaration.providerContract.maxVersion
  );
  if (canonical(declaration) !== canonical(route.declaration)) throw new Error('CMS registry declaration mismatch');
  if (exported.result === null) throw new Error('CMS export package has no usable result');
  const workspace = exported.result.workspaces.find((item) => item.source.sourceId === route.cms!.workspaceId);
  if (workspace === undefined || workspace.status !== 'success') throw new Error('CMS workspace package is not ready');
  const validatedPackage = route.cms.validatedPackage;
  if (
    validatedPackage.sourceWorkspaceId !== route.cms.workspaceId ||
    validatedPackage.packageManifestSha256 !== route.cms.manifestSha256 ||
    validatedPackage.sourceOrgId !== exported.provenance.sourceOrgId ||
    validatedPackage.pluginVersion !== exported.provenance.pluginVersion ||
    validatedPackage.exportSetId !== exported.provenance.exportSetId
  )
    throw new Error('CMS validated package provenance binding mismatch');
  const correlations = exported.result.externalReferenceCorrelations.filter(
    (row) => row.sourceWorkspaceId === route.cms!.workspaceId
  );
  if (
    canonical(
      validatedPackage.correlations.toSorted((left, right) => canonical(left).localeCompare(canonical(right)))
    ) !== canonical(correlations.toSorted((left, right) => canonical(left).localeCompare(canonical(right))))
  ) {
    throw new Error('CMS validated package correlation binding mismatch');
  }
  if (
    !validatedPackage.artifactPath ||
    !validatedPackage.manifestPath ||
    validatedPackage.correlations.some((row) => row.packageManifestSha256 !== route.cms!.manifestSha256)
  ) {
    throw new Error('CMS validated package evidence is incomplete');
  }
  if (workspace.artifact.manifestSha256 !== route.cms.manifestSha256) throw new Error('CMS manifest binding mismatch');
  if (route.packageManifestSha256 !== route.cms.manifestSha256)
    throw new Error('CMS selected package manifest mismatch');
  if (
    route.declaration.nativeScope.kind !== declaration.nativeScope.kind ||
    route.declaration.nativeScope.root !== declaration.nativeScope.root
  ) {
    throw new Error('CMS native scope/root mismatch');
  }
  return {
    registryHash: hashCanonical(registry.registry),
    manifestSha256: route.cms.manifestSha256,
    packageEvidenceHash: hashCanonical({
      ...validatedPackage,
      correlations: correlations.toSorted((left, right) => canonical(left).localeCompare(canonical(right))),
    }),
  };
}

function findCmsDeclaration(
  declarations: CmsRegistryDeclaration[],
  expected: CapabilityDeclaration
): CmsRegistryDeclaration {
  const matches = declarations.filter(
    (declaration) => canonical(declaration.identity) === canonical(expected.identity)
  );
  if (matches.length !== 1) throw new Error('CMS registry declaration is missing or ambiguous');
  return matches[0];
}

function requireVersionInRange(version: string, minimum: string, maximum: string): void {
  const current = semanticVersion(version);
  const min = semanticVersion(minimum);
  const max = semanticVersion(maximum);
  if (compareVersions(current, min) < 0 || compareVersions(current, max) > 0) {
    throw new Error('Deploy preflight provider version is incompatible');
  }
}

function semanticVersion(value: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error('Deploy preflight provider version is invalid');
  return value.split('.').map(Number);
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function identityKey(identity: PortableIdentity): string {
  return portableIdentityKey(identity);
}

function requireHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be lowercase SHA-256`);
}

function requireBytesHash(bytes: string | undefined, expected: string, label: string): void {
  requireHash(expected, `${label} hash`);
  if (typeof bytes !== 'string' || createHash('sha256').update(bytes, 'utf8').digest('hex') !== expected) {
    throw new Error(`${label} bytes hash mismatch`);
  }
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function canonical(value: unknown): string {
  return JSON.stringify(sortJson(value));
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
