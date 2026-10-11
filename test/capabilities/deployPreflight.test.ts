import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect } from 'chai';
import {
  planDeployPreflight,
  type DeployOperationRequest,
  type DeployRouteRequest,
} from '../../src/capabilities/deployPreflight.js';
import type {
  CapabilityDeclaration,
  DependencyDescriptor,
  PortableIdentity,
} from '../../src/capabilities/contracts.js';
import { lookupMcnCapability } from '../../src/capabilities/registry.js';
import {
  createResolutionCache,
  refreshResolutionCache,
  type ResolutionCacheScope,
  type TargetedResolutionRequest,
} from '../../src/capabilities/resolutionCache.js';
import { METADATA_CAPABILITY_CONTRACT, METADATA_CAPABILITY_FIXTURE_SHA256 } from '../../src/capabilities/contracts.js';
import { cloneFixture, validExportFixture, validRegistryInfoFixture } from '../cms/contractFixtures.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(sortJson(value));
const hashCanonical = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const targetContext = { businessUnitApiName: 'north' };
const target: PortableIdentity = { family: 'mcnext', type: 'Campaign', apiName: 'Dependency', context: targetContext };

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortJson((value as Record<string, unknown>)[key])])
  );
}

function campaignDeclaration(): CapabilityDeclaration {
  const result = lookupMcnCapability({
    provider: 'sf-plugin-mcnext',
    family: 'mcnext',
    type: 'Campaign',
    profile: 'relationship-free-scalar-resolver',
  });
  if (!result.available) throw new Error('expected Campaign declaration');
  return result.declaration;
}

function operation(
  operationId: string,
  identity: PortableIdentity,
  dependencies: DependencyDescriptor[] = []
): DeployOperationRequest {
  return {
    operationId,
    portableIdentity: identity,
    sourceBytes: `source:${operationId}`,
    sourceHash: hash(`source:${operationId}`),
    requestBytes: `request:${operationId}`,
    requestHash: hash(`request:${operationId}`),
    dependencies,
    dependencySources: [campaignRequest()],
  };
}

function dependency(
  resolution: DependencyDescriptor['resolution'] = 'either',
  portableTarget = target
): DependencyDescriptor {
  return {
    kind: 'campaign-reference',
    source: { family: 'mcnext', type: 'Campaign', apiName: 'Root', context: targetContext },
    target: portableTarget,
    required: true,
    resolution,
  };
}

function nativeRoute(operations: DeployOperationRequest[]): DeployRouteRequest {
  return {
    routeId: 'campaign',
    providerVersion: (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version,
    declaration: campaignDeclaration(),
    targetContext,
    operations,
    sidecars: [],
    transport: {
      salesforce: () => {
        throw new Error('must not call Salesforce');
      },
      cms: () => {
        throw new Error('must not call CMS');
      },
    },
  };
}

function campaignRequest(): TargetedResolutionRequest {
  return {
    kind: 'Campaign',
    source: {
      portableName: 'Dependency',
      context: targetContext,
      records: [
        {
          serverId: '701000000000001AAA',
          portableName: 'Dependency',
          context: targetContext,
          relationships: {
            ParentId: null,
            RecordTypeId: null,
            BriefId: null,
            CampaignImageId: null,
            CampaignMemberRecordTypeId: null,
          },
        },
      ],
      totalSize: 1,
      queryDone: true,
      completion: {
        strategy: 'targeted',
        completionProof: 'exact scalar record match',
        calls: 1,
        items: 1,
        pages: 1,
        complete: true,
      },
    },
  };
}

const cacheScope: ResolutionCacheScope = {
  sourceOrgId: '00D000000000001AAA',
  targetOrgId: '00D000000000002AAA',
  provider: 'sf-plugin-mcnext',
  apiVersion: '66.0',
  capabilityContract: METADATA_CAPABILITY_CONTRACT,
  capabilityFixtureSha256: METADATA_CAPABILITY_FIXTURE_SHA256,
  declaration: { type: 'Campaign', profile: 'relationship-free-scalar-resolver' },
  nativeContext: targetContext,
};

async function cacheRoute(): Promise<DeployRouteRequest> {
  const request = campaignRequest();
  const cache = await refreshResolutionCache(
    createResolutionCache(cacheScope),
    [request],
    async () => request,
    '2026-10-02T10:00:00.000Z'
  );
  return {
    ...nativeRoute([
      operation('root', { family: 'mcnext', type: 'Campaign', apiName: 'Root', context: targetContext }, [
        dependency('target'),
      ]),
    ]),
    cache: { value: cache, expectedScope: cacheScope },
  };
}

function cmsRoute(): DeployRouteRequest {
  const registryInfo = cloneFixture(validRegistryInfoFixture) as unknown as {
    result: { registry: { declarations: CapabilityDeclaration[] } };
  };
  registryInfo.result.registry.declarations[0].operations = ['retrieve', 'resolve'];
  const declaration = structuredClone(registryInfo.result.registry.declarations[0]);
  const packageManifestBytes = '{"package":"validated CMS fixture"}';
  const manifestSha256 = hash(packageManifestBytes);
  const exportEnvelope = cloneFixture(validExportFixture);
  const providerVersion = '0.9.0';
  const discovery = registryInfo as unknown as {
    metadata: { plugin: { version: string } };
    provenance: { pluginVersion: string };
    result: { plugin: { version: string } };
  };
  discovery.metadata.plugin.version = providerVersion;
  discovery.provenance.pluginVersion = providerVersion;
  discovery.result.plugin.version = providerVersion;
  exportEnvelope.metadata.plugin.version = providerVersion;
  exportEnvelope.provenance.pluginVersion = providerVersion;
  exportEnvelope.result!.workspaces[0].artifact.manifestSha256 = manifestSha256;
  exportEnvelope.result!.externalReferenceCorrelations[0].packageManifestSha256 = manifestSha256;
  return {
    routeId: 'cms',
    providerVersion: '0.9.0',
    declaration,
    targetContext: { workspaceId: '0ZuTarget' },
    operations: [operation('cms-email', { family: 'cms', type: 'Email', apiName: 'Welcome' })],
    sidecars: [],
    packageManifestSha256: manifestSha256,
    packageManifestBytes,
    cms: {
      registryInfo,
      exportEnvelope,
      workspaceId: '0ZuSource',
      manifestSha256,
      validatedPackage: {
        sourceWorkspaceId: '0ZuSource',
        artifactPath: 'Marketing Workspace',
        manifestPath: 'Marketing Workspace/manifest.json',
        packageManifestSha256: manifestSha256,
        sourceOrgId: validExportFixture.provenance.sourceOrgId,
        pluginVersion: exportEnvelope.provenance.pluginVersion,
        exportSetId: validExportFixture.provenance.exportSetId!,
        correlations: cloneFixture(exportEnvelope.result!.externalReferenceCorrelations),
      },
    },
    transport: {
      salesforce: () => {
        throw new Error('must not call Salesforce');
      },
      cms: () => {
        throw new Error('must not call CMS');
      },
    },
  };
}

describe('strict deploy preflight planning', () => {
  it('uses package-first precedence before exact mapping and cache evidence', async () => {
    const route = await cacheRoute();
    route.operations.push(operation('dependency', target));
    route.explicitMappings = [
      {
        portableIdentity: target,
        serverIdentity: { kind: 'salesforce-id', value: '701000000000009AAA' },
        targetContext,
        sourceHash: hashCanonical(campaignRequest()),
      },
    ];
    const plan = planDeployPreflight([route]).routes[0];
    expect(plan.status).to.equal('ready');
    expect(plan.operations.find((item) => item.operationId === 'root')!.dependencies[0].resolution).to.deep.include({
      method: 'package',
      operationId: 'dependency',
    });
  });

  it('allows exact target fallback only for target/either and gives mapping precedence over cache', async () => {
    const route = await cacheRoute();
    route.explicitMappings = [
      {
        portableIdentity: target,
        serverIdentity: { kind: 'salesforce-id', value: '701000000000009AAA' },
        targetContext,
        sourceHash: hashCanonical(campaignRequest()),
      },
    ];
    let dependencyPlan = planDeployPreflight([route]).routes[0].operations[0].dependencies[0];
    expect(dependencyPlan.resolution).to.deep.include({ method: 'mapping' });

    route.operations[0].dependencies[0].evidence = {
      serverIdentity: { kind: 'salesforce-id', value: '701000000000008AAA' },
    };
    expect(planDeployPreflight([route]).routes[0].blockedReasons.join(' ')).to.include(
      'explicit mapping evidence mismatch'
    );
    delete route.operations[0].dependencies[0].evidence;

    delete route.explicitMappings;
    dependencyPlan = planDeployPreflight([route]).routes[0].operations[0].dependencies[0];
    expect(dependencyPlan.resolution).to.deep.include({ method: 'cache' });

    route.operations[0].dependencies[0].resolution = 'package';
    expect(planDeployPreflight([route]).routes[0]).to.deep.include({ status: 'blocked' });
  });

  it('rejects stale cache evidence, context drift, and non-bijective explicit mappings', async () => {
    const stale = await cacheRoute();
    stale.operations[0].dependencies[0].evidence = {
      serverIdentity: { kind: 'salesforce-id', value: '701000000000009AAA' },
    };
    expect(planDeployPreflight([stale]).routes[0].blockedReasons.join(' ')).to.include('stale cache evidence');

    const isolated = await cacheRoute();
    isolated.targetContext = { businessUnitApiName: 'south' };
    expect(planDeployPreflight([isolated]).routes[0].blockedReasons[0]).to.include('target context mismatch');

    const crossProfile = await cacheRoute();
    const otherScope = { ...cacheScope, declaration: { type: 'Campaign' as const, profile: 'other-profile' } };
    crossProfile.cache = { value: createResolutionCache(otherScope), expectedScope: otherScope };
    expect(planDeployPreflight([crossProfile]).routes[0].blockedReasons[0]).to.include('capability scope mismatch');

    const mapped = nativeRoute([
      operation('root', { family: 'mcnext', type: 'Campaign', apiName: 'Root', context: targetContext }, [
        dependency(),
      ]),
    ]);
    const serverIdentity = { kind: 'salesforce-id' as const, value: '701000000000009AAA' };
    mapped.explicitMappings = [
      { portableIdentity: target, serverIdentity, targetContext, sourceHash: hash('one') },
      { portableIdentity: { ...target, apiName: 'Other' }, serverIdentity, targetContext, sourceHash: hash('two') },
    ];
    expect(planDeployPreflight([mapped]).routes[0].blockedReasons[0]).to.include('one-to-one');
  });

  it('rejects caller-mutated native declaration compatibility fields', () => {
    const route = nativeRoute([
      operation('root', { family: 'mcnext', type: 'Campaign', apiName: 'Root', context: targetContext }),
    ]);
    route.declaration = { ...route.declaration, dependencyExtractorVersion: 'caller-defined@9' };
    expect(planDeployPreflight([route]).routes[0].blockedReasons[0]).to.include('registry declaration mismatch');
  });

  it('blocks missing and ambiguous transitive package dependencies without fallback', () => {
    const root = operation('root', { family: 'mcnext', type: 'Campaign', apiName: 'Root', context: targetContext }, [
      dependency('package'),
    ]);
    expect(planDeployPreflight([nativeRoute([root])]).routes[0].blockedReasons.join(' ')).to.include(
      'missing package dependency'
    );

    const ambiguous = nativeRoute([root, operation('dependency-a', target), operation('dependency-b', target)]);
    expect(planDeployPreflight([ambiguous]).routes[0].blockedReasons.join(' ')).to.include(
      'ambiguous package dependency'
    );
  });

  it('binds CMS plans to the validated manifest and exact negotiated registry declaration', () => {
    const ready = planDeployPreflight([cmsRoute()]).routes[0];
    expect(ready).to.deep.include({ status: 'ready', manifestSha256: cmsRoute().cms!.manifestSha256 });
    expect(ready.registryHash).to.match(/^[a-f0-9]{64}$/);

    const manifestDrift = cmsRoute();
    manifestDrift.cms!.manifestSha256 = 'b'.repeat(64);
    expect(planDeployPreflight([manifestDrift]).routes[0].blockedReasons[0]).to.include('provenance binding mismatch');

    const incompatible = cmsRoute();
    incompatible.providerVersion = '2.0.0';
    expect(planDeployPreflight([incompatible]).routes[0].blockedReasons[0]).to.include('version');
  });

  it('accepts current local provider metadata and rejects incompatible native versions and false CMS provenance', () => {
    const native = nativeRoute([
      operation('root', { family: 'mcnext', type: 'Campaign', apiName: 'Root', context: targetContext }),
    ]);
    expect(planDeployPreflight([native]).routes[0].status).to.equal('ready');
    for (const providerVersion of ['0.8.0', '0.9.0', '0.9.999']) {
      expect(planDeployPreflight([{ ...native, providerVersion }]).routes[0].status).to.equal('ready');
    }
    for (const providerVersion of ['0.7.999', '0.10.0', '1.0.0']) {
      expect(planDeployPreflight([{ ...native, providerVersion }]).routes[0].status).to.equal('blocked');
    }
    const cms = cmsRoute();
    cms.providerVersion = '0.9.1';
    expect(planDeployPreflight([cms]).routes[0].blockedReasons.join(' ')).to.include('provenance binding');
    for (const providerVersion of ['0.8.999', '0.10.0', '1.0.0']) {
      const route = cmsRoute();
      route.providerVersion = providerVersion;
      const discovery = route.cms!.registryInfo as typeof validRegistryInfoFixture;
      const mutable = discovery as unknown as {
        metadata: { plugin: { version: string } };
        provenance: { pluginVersion: string };
        result: { plugin: { version: string } };
      };
      mutable.metadata.plugin.version = providerVersion;
      mutable.provenance.pluginVersion = providerVersion;
      mutable.result.plugin.version = providerVersion;
      const exported = route.cms!.exportEnvelope as typeof validExportFixture;
      exported.metadata.plugin.version = providerVersion;
      exported.provenance.pluginVersion = providerVersion;
      expect(planDeployPreflight([route]).routes[0].blockedReasons.join(' ')).to.include('version is incompatible');
    }
  });

  it('isolates route readiness and never downgrades blocked routes through fallback', async () => {
    const blocked = nativeRoute([
      operation('blocked', { family: 'mcnext', type: 'Campaign', apiName: 'Blocked', context: targetContext }, [
        {
          ...dependency('package'),
          source: { family: 'mcnext', type: 'Campaign', apiName: 'Blocked', context: targetContext },
        },
      ]),
    ]);
    const ready = await cacheRoute();
    ready.routeId = 'ready';
    const report = planDeployPreflight([blocked, ready]);
    expect(report.routes.find((route) => route.routeId === 'campaign')!.status).to.equal('blocked');
    expect(report.routes.find((route) => route.routeId === 'ready')!.status).to.equal('ready');
  });

  it('produces deterministic hashes while binding source, request, manifest, evidence, and sidecars', async () => {
    const route = await cacheRoute();
    const identity = route.operations[0].portableIdentity;
    const body = {
      contract: 'sf-mcnext-portable-retrieval-v1' as const,
      version: '1.0.0' as const,
      portableIdentity: identity,
      role: 'artifact-identity' as const,
      deployableDefinition: false as const,
    };
    const sidecar = { ...body, contentHash: hashCanonical(body) };
    const bytes = JSON.stringify(sidecar);
    route.sidecars = [{ path: 'pkg/root.portable.json', bytes, bytesSha256: hash(bytes), sidecar }];
    route.operations[0].sidecarPath = 'pkg/root.portable.json';
    route.packageManifestSha256 = hash('manifest');
    route.packageManifestBytes = 'manifest';
    route.operations.push(
      operation('independent', { family: 'mcnext', type: 'Campaign', apiName: 'Independent', context: targetContext })
    );
    route.operations[0].dependencies.push({
      ...dependency('target', { family: 'mcnext', type: 'Campaign', apiName: 'Optional', context: targetContext }),
      required: false,
    });
    route.operations[0].optionalDependencyOmissions = [
      {
        descriptorHash: hashCanonical(route.operations[0].dependencies[1]),
        semanticsEvidence: 'fixture proves this absent optional binding preserves semantics',
      },
    ];
    const first = planDeployPreflight([route]);
    const reversed = { ...route, operations: structuredClone(route.operations) };
    reversed.operations.reverse();
    reversed.operations.find((item) => item.operationId === 'root')!.dependencies.reverse();
    const second = planDeployPreflight([reversed]);
    expect(first.reportHash).to.equal(second.reportHash);
    const rootPlan = first.routes[0].operations.find((item) => item.operationId === 'root')!;
    expect(rootPlan).to.deep.include({ sidecarHash: hash(bytes), packageManifestSha256: hash('manifest') });
    expect(rootPlan.evidenceHashes).to.have.length(1);
  });

  it('rejects byte hash drift in source, request, manifest, and selected sidecars', () => {
    for (const field of ['sourceBytes', 'requestBytes'] as const) {
      const route = cmsRoute();
      route.operations[0][field] += 'tampered';
      expect(planDeployPreflight([route]).routes[0].blockedReasons.join(' ')).to.include('bytes hash mismatch');
    }
    const manifest = cmsRoute();
    manifest.packageManifestBytes += 'tampered';
    expect(planDeployPreflight([manifest]).routes[0].blockedReasons.join(' ')).to.include(
      'package manifest bytes hash mismatch'
    );
    const route = nativeRoute([]);
    const body = {
      contract: 'sf-mcnext-portable-retrieval-v1' as const,
      version: '1.0.0' as const,
      portableIdentity: target,
      role: 'artifact-identity' as const,
      deployableDefinition: false as const,
    };
    const sidecar = { ...body, contentHash: hashCanonical(body) };
    const bytes = JSON.stringify(sidecar);
    route.sidecars = [{ path: 'selected.json', bytes, bytesSha256: hash('different'), sidecar }];
    expect(planDeployPreflight([route]).routes[0].blockedReasons.join(' ')).to.include(
      'sidecar byte bytes hash mismatch'
    );
    route.sidecars[0].bytesSha256 = hash(bytes);
    route.sidecars[0].sidecar.portableIdentity = { ...target, apiName: 'Different' };
    expect(planDeployPreflight([route]).routes[0].blockedReasons.join(' ')).to.include(
      'bytes do not match selected object'
    );
  });

  it('rejects foreign dependency owners including optional dependencies', () => {
    const route = nativeRoute([
      operation('wrong-owner', { ...target, apiName: 'Different' }, [{ ...dependency(), required: false }]),
    ]);
    expect(planDeployPreflight([route]).routes[0].blockedReasons.join(' ')).to.include('owning operation identity');
  });

  it('binds mapping and cache hashes to independently validated dependency source evidence', async () => {
    const route = await cacheRoute();
    route.explicitMappings = [
      {
        portableIdentity: target,
        serverIdentity: { kind: 'salesforce-id', value: '701000000000009AAA' },
        targetContext,
        sourceHash: hash('wrong source'),
      },
    ];
    expect(planDeployPreflight([route]).routes[0].blockedReasons.join(' ')).to.include(
      'explicit mapping source hash mismatch'
    );
    route.operations.push(operation('dependency', target));
    expect(planDeployPreflight([route]).routes[0].status).to.equal('ready');
    route.operations.pop();
    delete route.explicitMappings;
    route.operations[0].dependencySources = [];
    expect(planDeployPreflight([route]).routes[0].blockedReasons.join(' ')).to.include('stale cache source evidence');
    const changed = campaignRequest();
    if (changed.kind === 'Campaign') changed.source.records[0].serverId = '701000000000008AAA';
    route.operations[0].dependencySources = [changed];
    expect(planDeployPreflight([route]).routes[0].blockedReasons.join(' ')).to.include('stale cache source evidence');
  });

  it('rejects drift and missing CMS validated correlations', () => {
    const route = cmsRoute();
    route.cms!.validatedPackage.correlations = [];
    expect(planDeployPreflight([route]).routes[0].blockedReasons.join(' ')).to.include('correlation binding mismatch');
    const drift = cmsRoute();
    drift.cms!.validatedPackage.correlations[0].referenceId = 'changed';
    expect(planDeployPreflight([drift]).routes[0].blockedReasons.join(' ')).to.include('correlation binding mismatch');
  });

  it('keeps package provenance deterministic when matched dependency order changes', () => {
    const root = operation('root', dependency().source, [dependency()]);
    const included = operation('included', target, [
      { ...dependency('package', { ...target, apiName: 'OptionalA' }), source: target, required: false },
      { ...dependency('package', { ...target, apiName: 'OptionalB' }), source: target, required: false },
    ]);
    const route = nativeRoute([root, included]);
    const first = planDeployPreflight([route]);
    included.dependencies.reverse();
    expect(planDeployPreflight([route]).reportHash).to.equal(first.reportHash);
  });

  it('integrates transitive blocking, cycles and ready-only layers without cross-route leakage', () => {
    const root = operation('root', dependency().source, [dependency('package')]);
    const missing = { ...target, apiName: 'Missing' };
    const included = operation('included', target, [{ ...dependency('package', missing), source: target }]);
    const isolated = nativeRoute([operation('independent', { ...target, apiName: 'Independent' })]);
    isolated.routeId = 'isolated';
    let report = planDeployPreflight([nativeRoute([root, included]), isolated]);
    expect(
      report.routes.find((item) => item.routeId === 'campaign')!.operations.find((item) => item.operationId === 'root')!
        .ready
    ).to.equal(false);
    expect(report.routes.find((item) => item.routeId === 'isolated')!.status).to.equal('ready');
    included.dependencies = [{ ...dependency('package', root.portableIdentity), source: target }];
    report = planDeployPreflight([nativeRoute([root, included])]);
    expect(report.routes[0].graph!.cycles[0][0]).to.equal(report.routes[0].graph!.cycles[0].at(-1));
    expect(report.routes[0].graph!.layers).to.deep.equal([]);
  });

  it('blocks unavailable types and present optional references unless omission is evidenced', () => {
    const optional = { ...dependency('package'), required: false };
    const root = operation('root', optional.source, [optional]);
    let plan = planDeployPreflight([nativeRoute([root])]).routes[0];
    expect(plan.status).to.equal('blocked');
    root.optionalDependencyOmissions = [
      { descriptorHash: hashCanonical(optional), semanticsEvidence: 'fixture absence is semantics-preserving' },
    ];
    plan = planDeployPreflight([nativeRoute([root])]).routes[0];
    expect(plan.status).to.equal('ready');
    root.dependencies[0].required = true;
    expect(planDeployPreflight([nativeRoute([root])]).routes[0].status).to.equal('blocked');
    const unsupported = operation('flow', { ...target, type: 'Flow' });
    const dependent = operation('root', dependency().source, [dependency('package', unsupported.portableIdentity)]);
    plan = planDeployPreflight([nativeRoute([dependent, unsupported])]).routes[0];
    expect(plan.operations.every((item) => !item.ready)).to.equal(true);
    expect(plan.blockedReasons.join(' ')).to.include('Unavailable provider/type');
  });

  it('makes zero Salesforce and CMS transport calls for blocked and ready dry-run planning', async () => {
    let salesforceCalls = 0;
    let cmsCalls = 0;
    const ready = await cacheRoute();
    ready.transport = {
      salesforce: () => {
        salesforceCalls += 1;
      },
      cms: () => {
        cmsCalls += 1;
      },
    };
    const blocked = nativeRoute([
      operation('blocked', { family: 'mcnext', type: 'Campaign', apiName: 'Blocked', context: targetContext }, [
        {
          ...dependency('package'),
          source: { family: 'mcnext', type: 'Campaign', apiName: 'Blocked', context: targetContext },
        },
      ]),
    ]);
    blocked.routeId = 'blocked';
    blocked.transport = ready.transport;
    const cms = cmsRoute();
    cms.transport = ready.transport;
    const report = planDeployPreflight([ready, blocked, cms]);
    expect(report.routes.map((route) => route.status)).to.include.members(['ready', 'blocked']);
    expect(salesforceCalls).to.equal(0);
    expect(cmsCalls).to.equal(0);
  });
});
