import { expect } from 'chai';
import {
  CmsContractError,
  resolveCmsCorrelation,
  validateCmsExport,
  validateCmsInfo,
  validateCmsStatusExit,
} from '../../src/cms/contracts.js';
import {
  cloneFixture,
  fixtureProvenance,
  publishedCapture,
  publishedInfoFixture,
  validExportFixture,
  validInfoFixture,
} from './contractFixtures.js';

function rejects(action: () => unknown, detail: string): void {
  expect(action).to.throw(CmsContractError, detail);
}

describe('CMS public contract boundary', () => {
  it('accepts contract-transcribed info with implemented and experimental capabilities', () => {
    expect(fixtureProvenance.info).to.equal('contract-transcribed');
    const validated = validateCmsInfo(validInfoFixture);
    expect(validated.capabilities).to.deep.equal({
      bulkExport: 'implemented',
      externalReferenceCorrelation: 'experimental',
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
    rejects(() => validateCmsInfo(publishedInfoFixture), 'CMS plugin must be at least 0.4.0');
  });

  it('keeps retained contract validation authoritative for later plugin versions', () => {
    const later = cloneFixture(validInfoFixture);
    later.metadata.plugin.version = '0.4.1';
    later.provenance.pluginVersion = '0.4.1';
    later.result!.plugin.version = '0.4.1';
    expect(() => validateCmsInfo(later)).to.not.throw();

    later.result!.contracts.commandResults.workspaceExportSet = ['2.0.0'];
    rejects(() => validateCmsInfo(later), 'export result major is unsupported');
  });

  it('blocks malformed, unknown, unavailable, old, and version-drift info', () => {
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

    const tooOld = cloneFixture(validInfoFixture);
    tooOld.metadata.plugin.version = '0.2.9';
    tooOld.provenance.pluginVersion = '0.2.9';
    tooOld.result!.plugin.version = '0.2.9';
    rejects(() => validateCmsInfo(tooOld), 'must be at least');

    const drift = cloneFixture(validInfoFixture);
    drift.contractVersion = '2.0.0';
    rejects(() => validateCmsInfo(drift), 'major is unsupported');
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
    wrongVersion.provenance.pluginVersion = '0.3.2';
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
