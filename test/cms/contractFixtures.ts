import { CMS_REGISTRY_FIXTURE_SHA256 } from '../../src/cms/contracts.js';
import type {
  CmsEnvelope,
  CmsExportArtifact,
  CmsExportResult,
  CmsExportWorkspace,
  CmsInfoResult,
  CmsRegistryResult,
} from '../../src/cms/contracts.js';

export const fixtureProvenance = {
  info: 'contract-transcribed',
  publishedInfo: 'published-captured-incompatible-export-transport',
  export: 'contract-transcribed',
  malformed: 'synthetic-negative',
} as const;

export const publishedCapture = {
  package: 'sf-plugin-cms@0.3.0',
  integrity: 'sha512-QEcezkXNfOeyGuTWRRktMDORZ9s5ZRyLu/POTK9L4sUpb8rt9L8X+l1wKhXOtHRDDmfcfMSjGYewVYtNfaCaTQ==',
  command: 'sf cms info --contract-version 1 --json',
  capturedAt: '2026-09-14',
} as const;

const hashA = 'a'.repeat(64);

export const validInfoFixture: CmsEnvelope<CmsInfoResult> = {
  contract: 'sf-cms-info',
  contractVersion: '1.0.0',
  status: 'success',
  metadata: {
    operation: 'cms.info',
    plugin: { name: 'sf-plugin-cms', version: '9.8.7' },
    apiVersion: null,
  },
  diagnostics: { warnings: [], errors: [] },
  provenance: {
    producer: 'sf-plugin-cms',
    sourceOrgId: 'offline',
    pluginVersion: '9.8.7',
    exportSetId: 'info:contract-transcribed',
    command: 'sf cms info',
    generatedAt: '2026-09-13T18:00:00.000Z',
  },
  result: {
    plugin: { name: 'sf-plugin-cms', version: '9.8.7' },
    api: { defaultVersion: '67.0', testedVersions: ['67.0'] },
    contracts: {
      commandResults: {
        info: ['1.0.0'],
        workspaceExportSet: ['1.0.0'],
        workspaceImport: ['1.0.0'],
      },
      packageManifests: { workspaceExport: ['1.0.0'] },
      embeddedResults: {
        externalReferenceCorrelations: ['sf-cms-external-reference-correlations@1'],
      },
      compatibility: {
        'workspaceExportSet@1': { workspaceExportManifestMajors: [1] },
        'workspaceImport@1': { workspaceExportManifestMajors: [1] },
        'workspaceImport@2': { workspaceExportManifestMajors: [2] },
      },
    },
    capabilities: [
      {
        id: 'workspace.export.bulk',
        state: 'implemented',
        transport: 'cli-json',
        contract: 'sf-cms-workspace-export-set@1',
      },
      {
        id: 'workspace.export.external-reference-correlation',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-external-reference-correlations@1',
      },
      {
        id: 'workspace.import.mapping',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-workspace-import@1',
      },
    ],
  },
};

export const publishedInfoFixture: CmsEnvelope<CmsInfoResult> = {
  ...cloneFixture(validInfoFixture),
  metadata: {
    ...cloneFixture(validInfoFixture.metadata),
    plugin: { name: 'sf-plugin-cms', version: '0.3.0' },
  },
  provenance: {
    producer: 'sf-plugin-cms',
    sourceOrgId: 'offline',
    pluginVersion: '0.3.0',
    command: 'sf cms info',
    generatedAt: '<sanitized-published-capture>',
  },
  result: {
    ...cloneFixture(validInfoFixture.result!),
    plugin: { name: 'sf-plugin-cms', version: '0.3.0' },
    capabilities: [
      {
        ...cloneFixture(validInfoFixture.result!.capabilities[0]),
        contract: 'sf-cms-workspace-export@1',
      },
      {
        id: 'workspace.export.dependency-closure',
        state: 'unavailable',
        transport: 'cli-json',
        contract: 'unavailable',
      },
      cloneFixture(validInfoFixture.result!.capabilities[1]),
      {
        id: 'workspace.import.mapping',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-workspace-import@1',
      },
    ],
  },
};

export const validRegistryInfoFixture = {
  ...cloneFixture(validInfoFixture),
  contractVersion: '2.0.0',
  result: {
    ...cloneFixture(validInfoFixture.result!),
    registry: {
      contract: 'sf-metadata-capability-v1',
      version: '1.0.0',
      fixtureSha256: CMS_REGISTRY_FIXTURE_SHA256,
      declarations: [
        {
          dependencyExtractorVersion: 'cms-email-dependencies@1',
          identity: { provider: 'sf-plugin-cms', family: 'cms', type: 'Email', profile: 'dependency-free' },
          nativeScope: { kind: 'marketing-workspace', root: 'email' },
          operations: ['retrieve'],
          preflight: {
            completionProof: 'exact workspace, API-name, and language match',
            hardBounds: { maxCalls: 5, maxItems: 1, maxPages: 1 },
            strategy: 'targeted',
          },
          providerContract: { maxVersion: '0.9.999', minVersion: '0.9.0', name: 'sf-plugin-cms' },
          retrieval: {
            completionProof: 'complete bounded family inventory',
            hardBounds: { maxCalls: 20, maxItems: 500, maxPages: 10 },
            strategy: 'filtered',
          },
        },
      ],
    },
  },
} as const;

export const validExportFixture: CmsEnvelope<
  CmsExportResult & { workspaces: Array<CmsExportWorkspace & { artifact: CmsExportArtifact }> }
> = {
  contract: 'sf-cms-workspace-export-set',
  contractVersion: '1.0.0',
  status: 'success',
  metadata: {
    operation: 'workspace.export.bulk',
    plugin: { name: 'sf-plugin-cms', version: '9.8.7' },
    apiVersion: '67.0',
  },
  diagnostics: { warnings: [], errors: [] },
  provenance: {
    producer: 'sf-plugin-cms',
    sourceOrgId: '00DSource',
    pluginVersion: '9.8.7',
    exportSetId: 'export-set:contract-transcribed',
    command: 'sf cms export workspace',
    generatedAt: '2026-09-13T18:00:00.000Z',
  },
  result: {
    workspaceType: 'Marketing',
    outputDirectory: './cms',
    selection: { mode: 'all', discoveredCount: 1, selectedCount: 1 },
    summary: { succeededCount: 1, partialCount: 0, failedCount: 0 },
    externalReferenceCorrelations: [
      {
        sourceWorkspaceId: '0ZuSource',
        sourceReference: ' OPAQUE:Case-Sensitive/Value== ',
        referenceKind: 'cms.content',
        referenceId: 'ref:canonical-provider-identity',
        packageManifestSha256: hashA,
      },
    ],
    workspaces: [
      {
        source: {
          kind: 'cms.workspace',
          sourceId: '0ZuSource',
          name: 'Marketing Workspace',
          workspaceType: 'Marketing',
        },
        status: 'success',
        artifact: {
          path: 'Marketing Workspace',
          manifestPath: 'Marketing Workspace/manifest.json',
          manifestContract: 'sf-cms-workspace-export',
          manifestContractVersion: '1.0.0',
          manifestSha256: hashA,
        },
        diagnostics: { warnings: [], errors: [] },
      },
    ],
  },
};

// Source-transcribed from current CMS info.ts and bulk-export-workspaces.ts; not live captures.
export const currentInfoFixture = cloneFixture(validInfoFixture);
currentInfoFixture.metadata.plugin.version = '0.9.0';
currentInfoFixture.provenance.pluginVersion = '0.9.0';
currentInfoFixture.result!.plugin.version = '0.9.0';
currentInfoFixture.result!.contracts.commandResults = {
  info: ['1.0.0'],
  contentDelete: ['1.0.0', '2.0.0'],
  contentPublish: ['1.0.0'],
  contentUnpublish: ['1.0.0'],
  contentUpdate: ['1.0.0', '2.0.0'],
  workspaceExportSet: ['1.0.0'],
  workspaceImport: ['1.0.0', '2.0.0'],
};
currentInfoFixture.result!.contracts.packageManifests.workspaceExport = ['1.0.0', '2.0.0'];
currentInfoFixture.result!.capabilities.push(
  ...[
    ['workspace.export.dependency-closure', 'unavailable', 'unavailable'],
    ['workspace.export.experimental-media', 'experimental', 'sf-cms-workspace-export@2'],
    ['content.delete.email', 'experimental', 'sf-cms-content-delete@1'],
    ['content.delete.email-template', 'experimental', 'sf-cms-content-delete@2'],
    ['content.publish.email', 'experimental', 'sf-cms-content-publish@1'],
    ['content.unpublish.email', 'experimental', 'sf-cms-content-unpublish@1'],
    ['content.update.email-raw-html', 'experimental', 'sf-cms-content-update@1'],
    ['content.update.email-template-raw-html', 'experimental', 'sf-cms-content-update@2'],
    ['workspace.import.email-fragment-create', 'experimental', 'sf-cms-workspace-import@1'],
    ['workspace.import.image-create', 'experimental', 'sf-cms-workspace-import@2'],
  ].map(([id, state, contract]) => ({
    id,
    state: state as 'experimental' | 'unavailable',
    transport: 'cli-json' as const,
    contract,
  }))
);
export const currentRegistryInfoFixture = {
  ...cloneFixture(currentInfoFixture),
  contractVersion: '2.0.0',
  result: {
    ...cloneFixture(currentInfoFixture.result!),
    registry: {
      contract: 'sf-metadata-capability-v1',
      version: '1.0.0',
      fixtureSha256: CMS_REGISTRY_FIXTURE_SHA256,
      declarations: [],
    } as CmsRegistryResult,
  },
};

currentRegistryInfoFixture.result.registry.declarations = [
  [
    'Brand',
    'dependency-free',
    'brand',
    'exact workspace and API-name match',
    4,
    1,
    'complete bounded family inventory',
    20,
    1,
  ],
  [
    'Consent Banner',
    'dependency-free',
    'consent-banner',
    'exact workspace and API-name match',
    4,
    1,
    'complete bounded family inventory',
    20,
    1,
  ],
  [
    'Email',
    'dependency-free',
    'email',
    'exact workspace, API-name, and language match',
    5,
    1,
    'complete bounded family inventory',
    20,
    1,
  ],
  [
    'Email Fragment',
    'dependency-free',
    'email-fragment',
    'exact workspace, API-name, and language match',
    5,
    1,
    'complete bounded family inventory',
    20,
    1,
  ],
  [
    'Email Template',
    'dependency-free',
    'email-template',
    'exact workspace, API-name, and language match',
    5,
    1,
    'complete bounded family inventory',
    20,
    1,
  ],
  [
    'Form Handler',
    'strict-empty-root',
    'form-handler',
    'exact workspace, API-name, and language match',
    5,
    1,
    'complete bounded family inventory',
    20,
    1,
  ],
  [
    'Landing Page',
    'strict-paired-template',
    'landing-page',
    'exact page and paired-template resolution',
    12,
    4,
    'complete bounded page and dependency inventory',
    30,
    2,
  ],
  [
    'Landing Page Template',
    'strict-image-data-graph',
    'landing-page-template',
    'exact template, image, and Data Graph resolution',
    16,
    20,
    'complete bounded template and dependency inventory',
    30,
    2,
  ],
  [
    'Preference Page',
    'strict-channel-subchannel-optional-brand',
    'preference-page',
    'exact channel, subchannel, and optional Brand resolution',
    12,
    10,
    'complete bounded preference-page inventory',
    30,
    2,
  ],
  [
    'Web Fragment',
    'strict-data-graph',
    'web-fragment',
    'exact fragment and Data Graph resolution',
    10,
    10,
    'complete bounded fragment inventory',
    30,
    2,
  ],
].map(
  ([
    type,
    profile,
    root,
    preflightProof,
    calls,
    items,
    retrievalProof,
    retrievalCalls,
    pages,
  ]): CmsRegistryResult['declarations'][number] => ({
    dependencyExtractorVersion: `cms-${root as string}-dependencies@1`,
    identity: { provider: 'sf-plugin-cms', family: 'cms', type: type as string, profile: profile as string },
    nativeScope: { kind: 'marketing-workspace', root: root as string },
    operations: ['retrieve'],
    preflight: {
      completionProof: preflightProof as string,
      hardBounds: { maxCalls: calls as number, maxItems: items as number, maxPages: pages as number },
      strategy: pages === 1 ? 'targeted' : 'batched',
    },
    providerContract: { maxVersion: '0.9.999', minVersion: '0.9.0', name: 'sf-plugin-cms' },
    retrieval: {
      completionProof: retrievalProof as string,
      hardBounds: { maxCalls: retrievalCalls as number, maxItems: 500, maxPages: 10 },
      strategy: 'filtered',
    },
  })
);

export const partialFailedExportFixture: CmsEnvelope<CmsExportResult> = cloneFixture(validExportFixture);
partialFailedExportFixture.status = 'partial';
partialFailedExportFixture.result!.workspaces.push({
  source: { kind: 'cms.workspace', sourceId: '0ZuSource2', name: 'Failed Workspace', workspaceType: 'Marketing' },
  status: 'failed',
  artifact: null,
  diagnostics: { warnings: [], errors: [{ code: 'WORKSPACE_EXPORT_FAILED', message: 'Workspace export failed.' }] },
});
partialFailedExportFixture.result!.selection = { mode: 'all', discoveredCount: 2, selectedCount: 2 };
partialFailedExportFixture.result!.summary = { succeededCount: 1, partialCount: 0, failedCount: 1 };
partialFailedExportFixture.diagnostics.errors = cloneFixture(
  partialFailedExportFixture.result!.workspaces[1].diagnostics.errors
);

export const failedExportFixture: CmsEnvelope<CmsExportResult> = cloneFixture(partialFailedExportFixture);
failedExportFixture.status = 'failed';
failedExportFixture.result!.workspaces.shift();
failedExportFixture.result!.externalReferenceCorrelations = [];
failedExportFixture.result!.selection = { mode: 'all', discoveredCount: 1, selectedCount: 1 };
failedExportFixture.result!.summary = { succeededCount: 0, partialCount: 0, failedCount: 1 };

export const blockedExportFixture: CmsEnvelope<CmsExportResult> = cloneFixture(validExportFixture);
blockedExportFixture.status = 'blocked';
blockedExportFixture.result = null;
blockedExportFixture.provenance.sourceOrgId = 'unresolved-org';
delete blockedExportFixture.provenance.exportSetId;
blockedExportFixture.diagnostics.errors = [
  { code: 'UNSUPPORTED_CONTRACT_VERSION', message: 'Unsupported contract major.', retryable: false },
];

export function cloneFixture<T>(value: T): T {
  return structuredClone(value);
}
