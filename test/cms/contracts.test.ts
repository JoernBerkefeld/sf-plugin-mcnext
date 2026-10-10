import { expect } from 'chai';
import {
  CMS_REGISTRY_FIXTURE_SHA256,
  CmsContractError,
  resolveCmsCorrelation,
  validateCmsExport,
  validateCmsInfo,
  validateCmsRegistryInfo,
  validateCmsStatusExit,
} from '../../src/cms/contracts.js';
import {
  cloneFixture,
  currentInfoFixture,
  currentRegistryInfoFixture,
  partialFailedExportFixture,
  failedExportFixture,
  blockedExportFixture,
  fixtureProvenance,
  publishedCapture,
  publishedInfoFixture,
  validExportFixture,
  validInfoFixture,
  validRegistryInfoFixture,
} from './contractFixtures.js';

function rejects(action: () => unknown, detail: string): void {
  expect(action).to.throw(CmsContractError, detail);
}

describe('CMS public contract boundary', () => {
  it('retains current lifecycle advertisements in v1 and v2 without creating routes', () => {
    expect(validateCmsInfo(currentInfoFixture).envelope.result).to.deep.equal(currentInfoFixture.result);
    expect(validateCmsRegistryInfo(currentRegistryInfoFixture).envelope.result).to.deep.equal(
      currentRegistryInfoFixture.result
    );
    for (const invalid of [true, '1.0.0', ['1'], ['1.0.0', false]]) {
      const fixture = cloneFixture(currentRegistryInfoFixture) as unknown as {
        result: { contracts: { commandResults: Record<string, unknown> } };
      };
      fixture.result.contracts.commandResults.contentDelete = invalid;
      expect(() => validateCmsRegistryInfo(fixture)).to.throw(CmsContractError);
    }
    const missing = cloneFixture(currentInfoFixture) as unknown as {
      result: { contracts: { commandResults: Record<string, unknown> } };
    };
    delete missing.result.contracts.commandResults.workspaceImport;
    rejects(() => validateCmsInfo(missing), 'command results fields');
    const unorderedRegistry = cloneFixture(currentRegistryInfoFixture);
    unorderedRegistry.result.registry.declarations.reverse();
    rejects(() => validateCmsRegistryInfo(unorderedRegistry), 'registry declarations must be canonically ordered');
    const duplicateRegistry = cloneFixture(currentRegistryInfoFixture);
    duplicateRegistry.result.registry.declarations.push(
      cloneFixture(duplicateRegistry.result.registry.declarations[0])
    );
    rejects(() => validateCmsRegistryInfo(duplicateRegistry), 'registry declarations must be unique');
    const hash = cloneFixture(currentRegistryInfoFixture) as unknown as {
      result: { registry: { fixtureSha256: string } };
    };
    hash.result.registry.fixtureSha256 = 'b'.repeat(64);
    rejects(() => validateCmsRegistryInfo(hash), 'registry fixture hash');
  });

  it('preserves real failed-null rows and terminal blocked-null evidence', () => {
    for (const fixture of [partialFailedExportFixture, failedExportFixture, blockedExportFixture]) {
      expect(validateCmsExport(fixture)).to.deep.equal(fixture);
    }
    const empty = cloneFixture(validExportFixture);
    empty.result!.workspaces = [];
    empty.result!.externalReferenceCorrelations = [];
    empty.result!.selection = { mode: 'all', discoveredCount: 0, selectedCount: 0 };
    empty.result!.summary = { succeededCount: 0, partialCount: 0, failedCount: 0 };
    expect(validateCmsExport(empty).status).to.equal('success');
    for (const status of ['success', 'partial', 'blocked']) {
      const fixture = cloneFixture(failedExportFixture) as unknown as {
        result: { workspaces: Array<{ status: string }> };
      };
      fixture.result.workspaces[0].status = status;
      rejects(() => validateCmsExport(fixture), 'workspace artifact is required');
    }
    const correlation = cloneFixture(partialFailedExportFixture);
    correlation.result!.externalReferenceCorrelations[0].sourceWorkspaceId = '0ZuSource2';
    rejects(() => validateCmsExport(correlation), 'correlation workspace binding');
    const missingId = cloneFixture(failedExportFixture);
    delete missingId.provenance.exportSetId;
    rejects(() => validateCmsExport(missingId), 'exportSetId is required');
    const wrongType = cloneFixture(failedExportFixture) as unknown as {
      result: { workspaces: Array<{ source: { workspaceType: string } }> };
    };
    wrongType.result.workspaces[0].source.workspaceType = 'Content';
    rejects(() => validateCmsExport(wrongType), 'workspace source type');
    for (const status of ['success', 'partial'] as const) {
      const fixture = cloneFixture(blockedExportFixture);
      fixture.status = status;
      rejects(() => validateCmsExport(fixture), 'result cannot be null');
    }
  });
  it('keeps additive advertisements bounded to version arrays and exact surrounding records', () => {
    const additive = cloneFixture(currentInfoFixture);
    additive.result!.contracts.commandResults.futureRead = ['1.0.0', '2.3.4'];
    expect(validateCmsInfo(additive).envelope.result!.contracts.commandResults.futureRead).to.deep.equal([
      '1.0.0',
      '2.3.4',
    ]);
    const unknown = cloneFixture(currentRegistryInfoFixture) as unknown as {
      result: { contracts: Record<string, unknown> };
    };
    unknown.result.contracts.future = {};
    rejects(() => validateCmsRegistryInfo(unknown), 'contracts fields');
  });

  it('allows missing export-set identity only for terminal null results', () => {
    const failed = cloneFixture(blockedExportFixture);
    failed.status = 'failed';
    expect(validateCmsExport(failed)).to.deep.equal(failed);
    for (const status of ['success', 'partial'] as const) {
      const fixture = cloneFixture(failed);
      fixture.status = status;
      rejects(() => validateCmsExport(fixture), 'result cannot be null');
    }
    const usable = cloneFixture(validExportFixture);
    delete usable.provenance.exportSetId;
    rejects(() => validateCmsExport(usable), 'exportSetId is required');
  });

  it('still rejects inconsistent summaries and duplicate retained paths beside null failures', () => {
    const wrongCount = cloneFixture(partialFailedExportFixture);
    wrongCount.result!.summary.failedCount = 0;
    rejects(() => validateCmsExport(wrongCount), 'summary counts');
    const wrongStatus = cloneFixture(partialFailedExportFixture);
    wrongStatus.status = 'success';
    rejects(() => validateCmsExport(wrongStatus), 'export status');
    const duplicate = cloneFixture(partialFailedExportFixture);
    duplicate.result!.workspaces.push({
      ...cloneFixture(duplicate.result!.workspaces[0]),
      source: { ...duplicate.result!.workspaces[0].source, sourceId: '0ZuSource3' },
    });
    duplicate.result!.selection = { mode: 'all', discoveredCount: 3, selectedCount: 3 };
    duplicate.result!.summary.succeededCount = 2;
    rejects(() => validateCmsExport(duplicate), 'duplicate artifact path');
  });

  it('accepts forward-compatible compatibility advertisements independent of provider semver', () => {
    const validated = validateCmsInfo(validInfoFixture);

    expect(validated.envelope.result!.plugin.version).to.equal('9.8.7');
    expect(validated.envelope.result!.contracts.compatibility['workspaceImport@2']).to.deep.equal({
      workspaceExportManifestMajors: [2],
    });
  });

  it('accepts contract-transcribed info with implemented and experimental capabilities', () => {
    expect(fixtureProvenance.info).to.equal('contract-transcribed');
    const validated = validateCmsInfo(validInfoFixture);
    expect(validated.capabilities).to.deep.equal({
      bulkExport: 'implemented',
      externalReferenceCorrelation: 'experimental',
      workspaceImport: 'experimental',
      experimental: true,
    });
  });

  it('retains the sanitized published-captured 0.3.0 info fixture as incompatible export-transport evidence', () => {
    expect(fixtureProvenance.publishedInfo).to.equal('published-captured-incompatible-export-transport');
    expect(publishedCapture).to.deep.include({
      package: 'sf-plugin-cms@0.3.0',
      command: 'sf cms info --contract-version 1 --json',
    });
    expect(publishedInfoFixture.provenance).not.to.have.property('exportSetId');
    rejects(() => validateCmsInfo(publishedInfoFixture), 'capability contract workspace.export.bulk');
  });

  it('keeps retained contract validation authoritative for later plugin versions', () => {
    const later = cloneFixture(validInfoFixture);
    later.metadata.plugin.version = '10.0.0';
    later.provenance.pluginVersion = '10.0.0';
    later.result!.plugin.version = '10.0.0';
    expect(() => validateCmsInfo(later)).to.not.throw();

    later.result!.contracts.commandResults.workspaceExportSet = ['2.0.0'];
    rejects(() => validateCmsInfo(later), 'export result major is unsupported');
  });

  it('blocks malformed, unknown, unavailable, and contract-major drift info', () => {
    const unknownField = cloneFixture(validInfoFixture) as unknown as Record<string, unknown>;
    unknownField.extra = true;
    rejects(() => validateCmsInfo(unknownField), 'envelope fields');

    const unknownState = cloneFixture(validInfoFixture) as unknown as {
      result: { capabilities: Array<{ state: string }> };
    };
    unknownState.result.capabilities[0].state = 'preview';
    rejects(() => validateCmsInfo(unknownState), 'capability state is unknown');

    const unavailable = cloneFixture(validInfoFixture);
    unavailable.result!.capabilities[1].state = 'unavailable';
    rejects(() => validateCmsInfo(unavailable), 'capability unavailable');

    const drift = cloneFixture(validInfoFixture);
    drift.contractVersion = '2.0.0';
    rejects(() => validateCmsInfo(drift), 'major is unsupported');
  });

  it('strictly validates CMS-only v2 registry discovery and fails closed', () => {
    const validated = validateCmsRegistryInfo(validRegistryInfoFixture);
    expect(validated.registry).to.deep.include({
      contract: 'sf-metadata-capability-v1',
      version: '1.0.0',
      fixtureSha256: CMS_REGISTRY_FIXTURE_SHA256,
    });
    expect(validated.registry.declarations.map((entry) => entry.identity.type)).to.deep.equal(['Email']);

    const wrongProvider = cloneFixture(validRegistryInfoFixture) as unknown as {
      result: { registry: { declarations: Array<{ identity: { provider: string } }> } };
    };
    wrongProvider.result.registry.declarations[0].identity.provider = 'sf-plugin-mcnext';
    rejects(() => validateCmsRegistryInfo(wrongProvider), 'registry provider');

    const unavailable = cloneFixture(validRegistryInfoFixture) as unknown as {
      status: string;
      result: unknown;
      diagnostics: { errors: unknown[] };
    };
    unavailable.status = 'blocked';
    unavailable.result = null;
    unavailable.diagnostics.errors = [
      { code: 'UNSUPPORTED_CONTRACT_VERSION', message: 'unsupported', retryable: false },
    ];
    rejects(() => validateCmsRegistryInfo(unavailable), 'registry unavailable or incompatible');

    const v1WithRows = cloneFixture(validInfoFixture) as unknown as { result: Record<string, unknown> };
    v1WithRows.result.registry = validRegistryInfoFixture.result.registry;
    rejects(() => validateCmsInfo(v1WithRows), 'info result fields');
  });

  it('accepts the exact five-field correlation row and preserves the opaque source value', () => {
    expect(fixtureProvenance.export).to.equal('contract-transcribed');
    const envelope = validateCmsExport(validExportFixture);
    const row = resolveCmsCorrelation(envelope, '0ZuSource', ' OPAQUE:Case-Sensitive/Value== ');
    expect(Object.keys(row).sort()).to.deep.equal([
      'packageManifestSha256',
      'referenceId',
      'referenceKind',
      'sourceReference',
      'sourceWorkspaceId',
    ]);
    expect(row.sourceReference).to.equal(' OPAQUE:Case-Sensitive/Value== ');
    rejects(
      () => resolveCmsCorrelation(envelope, '0ZuSource', 'opaque:case-sensitive/value=='),
      'unresolved correlation'
    );
    rejects(
      () => resolveCmsCorrelation(envelope, '0ZuSource', 'OPAQUE:Case-Sensitive/Value=='),
      'unresolved correlation'
    );
  });

  it('blocks malformed rows and unknown manifest versions', () => {
    const extraField = cloneFixture(validExportFixture) as unknown as {
      result: { externalReferenceCorrelations: Array<Record<string, unknown>> };
    };
    extraField.result.externalReferenceCorrelations[0].candidate = 'derived';
    rejects(() => validateCmsExport(extraField), 'correlation fields');

    const unknownKind = cloneFixture(validExportFixture) as unknown as {
      result: { externalReferenceCorrelations: Array<{ referenceKind: string }> };
    };
    unknownKind.result.externalReferenceCorrelations[0].referenceKind = 'cms.unknown';
    rejects(() => validateCmsExport(unknownKind), 'referenceKind must be cms.content');

    const manifestDrift = cloneFixture(validExportFixture);
    manifestDrift.result!.workspaces[0].artifact.manifestContractVersion = '2.0.0';
    rejects(() => validateCmsExport(manifestDrift), 'manifest contract version major is unsupported');
  });

  it('reconciles canonical workspace/correlation order, counts, status, paths, and command provenance', () => {
    const unordered = cloneFixture(validExportFixture);
    unordered.result!.workspaces.push({
      ...cloneFixture(unordered.result!.workspaces[0]),
      source: { ...unordered.result!.workspaces[0].source, sourceId: '0AaFirst' },
      artifact: {
        ...unordered.result!.workspaces[0].artifact,
        path: 'First',
        manifestPath: 'First/manifest.json',
        manifestSha256: 'b'.repeat(64),
      },
    });
    unordered.result!.selection = { mode: 'all', discoveredCount: 2, selectedCount: 2 };
    unordered.result!.summary.succeededCount = 2;
    rejects(() => validateCmsExport(unordered), 'workspace IDs must be canonically ordered');

    const discoveredMoreThanSelected = cloneFixture(validExportFixture);
    discoveredMoreThanSelected.result!.selection.discoveredCount = 2;
    expect(() => validateCmsExport(discoveredMoreThanSelected)).to.not.throw();

    const selectedCountMismatch = cloneFixture(validExportFixture);
    selectedCountMismatch.result!.selection.selectedCount = 0;
    rejects(() => validateCmsExport(selectedCountMismatch), 'selection counts');

    const discoveredCountTooSmall = cloneFixture(validExportFixture);
    discoveredCountTooSmall.result!.selection.discoveredCount = 0;
    rejects(() => validateCmsExport(discoveredCountTooSmall), 'selection counts');

    const badSummary = cloneFixture(validExportFixture);
    badSummary.result!.summary.failedCount = 1;
    rejects(() => validateCmsExport(badSummary), 'summary counts');

    const badStatus = cloneFixture(validExportFixture);
    badStatus.status = 'partial';
    rejects(() => validateCmsExport(badStatus), 'export status');

    const duplicatePath = cloneFixture(validExportFixture);
    duplicatePath.result!.workspaces.push(cloneFixture(duplicatePath.result!.workspaces[0]));
    duplicatePath.result!.workspaces[1].source.sourceId = '0ZuSource2';
    duplicatePath.result!.selection = { mode: 'all', discoveredCount: 2, selectedCount: 2 };
    duplicatePath.result!.summary.succeededCount = 2;
    rejects(() => validateCmsExport(duplicatePath), 'duplicate artifact path');

    const wrongInfoCommand = cloneFixture(validInfoFixture);
    wrongInfoCommand.provenance.command = 'sf cms info --other';
    rejects(() => validateCmsInfo(wrongInfoCommand), 'info command provenance');
    const wrongExportCommand = cloneFixture(validExportFixture);
    wrongExportCommand.provenance.command = 'sf cms export workspace --other';
    rejects(() => validateCmsExport(wrongExportCommand), 'export command provenance');
  });

  it('blocks wrong package/workspace/provenance bindings', () => {
    const wrongPackage = cloneFixture(validExportFixture);
    wrongPackage.result!.externalReferenceCorrelations[0].packageManifestSha256 = 'b'.repeat(64);
    rejects(() => validateCmsExport(wrongPackage), 'correlation package binding');

    const wrongWorkspace = cloneFixture(validExportFixture);
    wrongWorkspace.result!.externalReferenceCorrelations[0].sourceWorkspaceId = '0ZuOther';
    rejects(() => validateCmsExport(wrongWorkspace), 'correlation workspace binding');

    const wrongProducer = cloneFixture(validExportFixture) as unknown as { provenance: { producer: string } };
    wrongProducer.provenance.producer = 'other-plugin';
    rejects(() => validateCmsExport(wrongProducer), 'producer must be sf-plugin-cms');

    const wrongVersion = cloneFixture(validExportFixture);
    wrongVersion.provenance.pluginVersion = '1.2.3';
    rejects(() => validateCmsExport(wrongVersion), 'envelope provenance binding');
  });

  it('blocks duplicate exact sources, conflicts, and incompatible referenceId reuse', () => {
    const duplicate = cloneFixture(validExportFixture);
    duplicate.result!.externalReferenceCorrelations.push({
      ...duplicate.result!.externalReferenceCorrelations[0],
    });
    rejects(() => validateCmsExport(duplicate), 'correlation rows must be unique');

    const conflict = cloneFixture(validExportFixture);
    conflict.result!.externalReferenceCorrelations.push({
      ...conflict.result!.externalReferenceCorrelations[0],
      referenceId: 'ref:conflicting-provider-identity',
    });
    rejects(() => validateCmsExport(conflict), 'correlation rows must be unique');

    const reuse = cloneFixture(validExportFixture);
    reuse.result!.externalReferenceCorrelations.push({
      ...reuse.result!.externalReferenceCorrelations[0],
      sourceReference: 'second-exact-source',
    });
    rejects(() => validateCmsExport(reuse), 'incompatible referenceId reuse');
  });

  it('blocks diagnosed unresolved source values instead of treating them as mappings', () => {
    const unresolved = cloneFixture(validExportFixture);
    unresolved.status = 'partial';
    unresolved.result!.workspaces[0].status = 'partial';
    unresolved.result!.summary = { succeededCount: 0, partialCount: 1, failedCount: 0 };
    unresolved.result!.workspaces[0].diagnostics.errors.push({
      code: 'UNRESOLVED_EXTERNAL_REFERENCE',
      message: 'Provider could not resolve the exact source value.',
      reference: 'missing-opaque-value',
    });
    const envelope = validateCmsExport(unresolved);
    rejects(() => resolveCmsCorrelation(envelope, '0ZuSource', 'missing-opaque-value'), 'unresolved or diagnosed');
  });

  it('enforces command-owned status and exit pairs', () => {
    for (const [status, exitCode] of [
      ['success', 0],
      ['partial', 2],
      ['failed', 1],
      ['blocked', 1],
    ] as const) {
      expect(() => validateCmsStatusExit(status, exitCode)).to.not.throw();
    }
    rejects(() => validateCmsStatusExit('success', 1), 'status success requires exit 0');
    rejects(() => validateCmsStatusExit('partial', 0), 'status partial requires exit 2');
    rejects(() => validateCmsStatusExit('failed', 2), 'status failed requires exit 1');
  });
});
