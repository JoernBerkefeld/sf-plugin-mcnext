import type { CmsEnvelope, CmsExportResult, CmsInfoResult } from '../../src/cms/contracts.js';

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
    plugin: { name: 'sf-plugin-cms', version: '0.4.0' },
    apiVersion: null,
  },
  diagnostics: { warnings: [], errors: [] },
  provenance: {
    producer: 'sf-plugin-cms',
    sourceOrgId: 'offline',
    pluginVersion: '0.4.0',
    exportSetId: 'info:contract-transcribed',
    command: 'sf cms info',
    generatedAt: '2026-09-13T18:00:00.000Z',
  },
  result: {
    plugin: { name: 'sf-plugin-cms', version: '0.4.0' },
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
      cloneFixture(validInfoFixture.result!.capabilities[0]),
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

export const validExportFixture: CmsEnvelope<CmsExportResult> = {
  contract: 'sf-cms-workspace-export-set',
  contractVersion: '1.0.0',
  status: 'success',
  metadata: {
    operation: 'workspace.export.bulk',
    plugin: { name: 'sf-plugin-cms', version: '0.4.0' },
    apiVersion: '67.0',
  },
  diagnostics: { warnings: [], errors: [] },
  provenance: {
    producer: 'sf-plugin-cms',
    sourceOrgId: '00DSource',
    pluginVersion: '0.4.0',
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

export function cloneFixture<T>(value: T): T {
  return structuredClone(value);
}
