export const CMS_PLUGIN_NAME = 'sf-plugin-cms' as const;
export const CMS_MINIMUM_PLUGIN_VERSION = '0.4.0' as const;
export const CMS_INFO_CONTRACT = 'sf-cms-info' as const;
export const CMS_EXPORT_CONTRACT = 'sf-cms-workspace-export-set' as const;
export const CMS_CORRELATION_CONTRACT = 'sf-cms-external-reference-correlations@1' as const;
export const CMS_BULK_EXPORT_CAPABILITY = 'workspace.export.bulk' as const;
export const CMS_CORRELATION_CAPABILITY = 'workspace.export.external-reference-correlation' as const;
export const CMS_REFERENCE_KIND = 'cms.content' as const;
export const CMS_INFO_COMMAND = 'sf cms info' as const;
export const CMS_EXPORT_COMMAND = 'sf cms export workspace' as const;

export type CmsStatus = 'success' | 'partial' | 'failed' | 'blocked';
export type CmsCapabilityState = 'implemented' | 'experimental' | 'unavailable';
export type CmsOperation = 'cms.info' | 'workspace.export.bulk';

export type CmsDiagnostic = {
  code: string;
  message: string;
  scope?: string;
  reference?: string;
  retryable?: boolean;
};

export type CmsDiagnostics = {
  warnings: CmsDiagnostic[];
  errors: CmsDiagnostic[];
};

export type CmsProvenance = {
  producer: typeof CMS_PLUGIN_NAME;
  sourceOrgId: string;
  pluginVersion: string;
  exportSetId?: string;
  command: string;
  generatedAt: string;
};

export type CmsCapability = {
  id: string;
  state: CmsCapabilityState;
  transport: 'cli-json';
  contract: string;
};

export type CmsInfoResult = {
  plugin: { name: typeof CMS_PLUGIN_NAME; version: string };
  api: { defaultVersion: string; testedVersions: string[] };
  contracts: {
    commandResults: { info: string[]; workspaceExportSet: string[]; workspaceImport: string[] };
    packageManifests: { workspaceExport: string[] };
    embeddedResults: { externalReferenceCorrelations: [typeof CMS_CORRELATION_CONTRACT] };
    compatibility: {
      'workspaceExportSet@1': { workspaceExportManifestMajors: number[] };
      'workspaceImport@1': { workspaceExportManifestMajors: number[] };
    };
  };
  capabilities: CmsCapability[];
};

export type CmsExternalReferenceCorrelation = {
  sourceWorkspaceId: string;
  sourceReference: string;
  referenceKind: typeof CMS_REFERENCE_KIND;
  referenceId: string;
  packageManifestSha256: string;
};

export type CmsExportWorkspace = {
  source: { kind: 'cms.workspace'; sourceId: string; name: string; workspaceType: 'Marketing' };
  status: CmsStatus;
  artifact: {
    path: string;
    manifestPath: string;
    manifestContract: 'sf-cms-workspace-export';
    manifestContractVersion: string;
    manifestSha256: string;
  };
  diagnostics: CmsDiagnostics;
};

export type CmsExportResult = {
  workspaceType: 'Marketing';
  outputDirectory: string;
  selection: { mode: 'all'; discoveredCount: number; selectedCount: number };
  summary: { succeededCount: number; partialCount: number; failedCount: number };
  externalReferenceCorrelations: CmsExternalReferenceCorrelation[];
  workspaces: CmsExportWorkspace[];
};

export type CmsEnvelope<TResult> = {
  contract: string;
  contractVersion: string;
  status: CmsStatus;
  metadata: {
    operation: CmsOperation;
    plugin: { name: typeof CMS_PLUGIN_NAME; version: string };
    apiVersion: string | null;
  };
  diagnostics: CmsDiagnostics;
  provenance: CmsProvenance;
  result: TResult | null;
};

export type CmsCapabilitySelection = {
  bulkExport: 'implemented' | 'experimental';
  externalReferenceCorrelation: 'implemented' | 'experimental';
  experimental: boolean;
};

export class CmsContractError extends Error {}

/** Validate the frozen CMS info boundary and select the two required capabilities. */
export function validateCmsInfo(value: unknown): {
  envelope: CmsEnvelope<CmsInfoResult>;
  capabilities: CmsCapabilitySelection;
} {
  const envelope = validateEnvelope(value, 'cms.info', CMS_INFO_CONTRACT, validateInfoResult);
  if (envelope.provenance.command !== CMS_INFO_COMMAND) throw contractError('info command provenance');
  if (envelope.status !== 'success' || envelope.result === null) throw contractError('CMS info must be successful');
  if (!isAtLeastVersion(envelope.result.plugin.version, CMS_MINIMUM_PLUGIN_VERSION)) {
    throw contractError(`CMS plugin must be at least ${CMS_MINIMUM_PLUGIN_VERSION}`);
  }
  if (envelope.metadata.plugin.version !== envelope.result.plugin.version)
    throw contractError('plugin version binding');
  requireMajor(envelope.result.contracts.commandResults.info, 1, 'info result');
  requireMajor(envelope.result.contracts.commandResults.workspaceExportSet, 1, 'export result');
  requireMajor(envelope.result.contracts.packageManifests.workspaceExport, 1, 'workspace manifest');
  if (!envelope.result.contracts.compatibility['workspaceExportSet@1'].workspaceExportManifestMajors.includes(1)) {
    throw contractError('export result and manifest compatibility');
  }
  const correlationContracts = envelope.result.contracts.embeddedResults.externalReferenceCorrelations;
  if (correlationContracts.length !== 1 || correlationContracts[0] !== CMS_CORRELATION_CONTRACT) {
    throw contractError('correlation contract advertisement');
  }

  const bulkExport = requiredCapability(
    envelope.result.capabilities,
    CMS_BULK_EXPORT_CAPABILITY,
    `${CMS_EXPORT_CONTRACT}@1`
  );
  const externalReferenceCorrelation = requiredCapability(
    envelope.result.capabilities,
    CMS_CORRELATION_CAPABILITY,
    CMS_CORRELATION_CONTRACT
  );
  return {
    envelope,
    capabilities: {
      bulkExport,
      externalReferenceCorrelation,
      experimental: bulkExport === 'experimental' || externalReferenceCorrelation === 'experimental',
    },
  };
}

/** Validate the frozen aggregate Marketing workspace export boundary. */
export function validateCmsExport(value: unknown): CmsEnvelope<CmsExportResult> {
  const envelope = validateEnvelope(value, 'workspace.export.bulk', CMS_EXPORT_CONTRACT, validateExportResult);
  if (envelope.provenance.command !== CMS_EXPORT_COMMAND) throw contractError('export command provenance');
  if (envelope.provenance.exportSetId === undefined) throw contractError('exportSetId is required for export');
  if (envelope.result === null) return envelope;
  if (envelope.provenance.pluginVersion !== envelope.metadata.plugin.version)
    throw contractError('provenance plugin version');

  validateExportConsistency(envelope);
  const workspaces = new Map(envelope.result.workspaces.map((workspace) => [workspace.source.sourceId, workspace]));
  const exactSources = new Set<string>();
  const referenceBindings = new Map<string, string>();
  for (const row of envelope.result.externalReferenceCorrelations) {
    const workspace = workspaces.get(row.sourceWorkspaceId);
    if (!workspace) throw contractError('correlation workspace binding');
    if (workspace.artifact.manifestSha256 !== row.packageManifestSha256)
      throw contractError('correlation package binding');
    const sourceKey = `${row.sourceWorkspaceId}\0${row.sourceReference}`;
    if (exactSources.has(sourceKey)) throw contractError('duplicate or conflicting exact source correlation');
    exactSources.add(sourceKey);
    const binding = `${row.sourceWorkspaceId}\0${row.referenceKind}\0${row.sourceReference}\0${row.packageManifestSha256}`;
    const existing = referenceBindings.get(row.referenceId);
    if (existing !== undefined && existing !== binding) throw contractError('incompatible referenceId reuse');
    referenceBindings.set(row.referenceId, binding);
  }
  return envelope;
}

/** Resolve exactly one provider correlation or fail closed. */
export function resolveCmsCorrelation(
  envelope: CmsEnvelope<CmsExportResult>,
  sourceWorkspaceId: string,
  sourceReference: string
): CmsExternalReferenceCorrelation {
  if (envelope.result === null) throw contractError('export has no usable result');
  const workspace = envelope.result.workspaces.find((entry) => entry.source.sourceId === sourceWorkspaceId);
  if (!workspace) throw contractError('unresolved workspace');
  const diagnostics = [
    ...envelope.diagnostics.warnings,
    ...envelope.diagnostics.errors,
    ...workspace.diagnostics.warnings,
    ...workspace.diagnostics.errors,
  ];
  if (diagnostics.some((diagnostic) => diagnostic.reference === sourceReference)) {
    throw contractError('source reference is unresolved or diagnosed');
  }
  const matches = envelope.result.externalReferenceCorrelations.filter(
    (row) => row.sourceWorkspaceId === sourceWorkspaceId && row.sourceReference === sourceReference
  );
  if (matches.length !== 1)
    throw contractError(matches.length === 0 ? 'unresolved correlation' : 'duplicate correlation');
  return matches[0];
}

/** Enforce the command-owned status and process-exit contract. */
export function validateCmsStatusExit(status: CmsStatus, exitCode: number): void {
  const expected = status === 'success' ? 0 : status === 'partial' ? 2 : 1;
  if (exitCode !== expected) throw contractError(`status ${status} requires exit ${expected}`);
}

function validateEnvelope<TResult>(
  value: unknown,
  operation: CmsOperation,
  contract: string,
  resultValidator: (value: unknown) => TResult
): CmsEnvelope<TResult> {
  const record = strictRecord(
    value,
    ['contract', 'contractVersion', 'status', 'metadata', 'diagnostics', 'provenance', 'result'],
    'envelope'
  );
  exact(record.contract, contract, 'contract');
  versionMajor(record.contractVersion, 1, 'contractVersion');
  const status = oneOf(record.status, ['success', 'partial', 'failed', 'blocked'] as const, 'status');
  const metadata = strictRecord(record.metadata, ['operation', 'plugin', 'apiVersion'], 'metadata');
  exact(metadata.operation, operation, 'operation');
  const plugin = validatePlugin(metadata.plugin);
  const apiVersion = metadata.apiVersion === null ? null : string(metadata.apiVersion, 'apiVersion');
  const diagnostics = validateDiagnostics(record.diagnostics);
  const provenance = validateProvenance(record.provenance);
  if (provenance.producer !== plugin.name || provenance.pluginVersion !== plugin.version)
    throw contractError('envelope provenance binding');
  const result = record.result === null ? null : resultValidator(record.result);
  if (result === null && status !== 'failed' && status !== 'blocked')
    throw contractError('successful or partial result cannot be null');
  return {
    contract,
    contractVersion: string(record.contractVersion, 'contractVersion'),
    status,
    metadata: { operation, plugin, apiVersion },
    diagnostics,
    provenance,
    result,
  };
}

function validateInfoResult(value: unknown): CmsInfoResult {
  const record = strictRecord(value, ['plugin', 'api', 'contracts', 'capabilities'], 'info result');
  const plugin = validatePlugin(record.plugin);
  const api = strictRecord(record.api, ['defaultVersion', 'testedVersions'], 'api');
  const contracts = strictRecord(
    record.contracts,
    ['commandResults', 'packageManifests', 'embeddedResults', 'compatibility'],
    'contracts'
  );
  const commandResults = strictRecord(
    contracts.commandResults,
    ['info', 'workspaceExportSet', 'workspaceImport'],
    'command results'
  );
  const packageManifests = strictRecord(contracts.packageManifests, ['workspaceExport'], 'package manifests');
  const embeddedResults = strictRecord(
    contracts.embeddedResults,
    ['externalReferenceCorrelations'],
    'embedded results'
  );
  const compatibility = strictRecord(
    contracts.compatibility,
    ['workspaceExportSet@1', 'workspaceImport@1'],
    'compatibility'
  );
  const exportCompatibility = validateManifestCompatibility(compatibility['workspaceExportSet@1']);
  const importCompatibility = validateManifestCompatibility(compatibility['workspaceImport@1']);
  const correlations = stringArray(embeddedResults.externalReferenceCorrelations, 'correlation contracts');
  if (correlations.length !== 1 || correlations[0] !== CMS_CORRELATION_CONTRACT)
    throw contractError('correlation contract');
  return {
    plugin,
    api: {
      defaultVersion: string(api.defaultVersion, 'default API version'),
      testedVersions: stringArray(api.testedVersions, 'tested API versions'),
    },
    contracts: {
      commandResults: {
        info: stringArray(commandResults.info, 'info versions'),
        workspaceExportSet: stringArray(commandResults.workspaceExportSet, 'export versions'),
        workspaceImport: stringArray(commandResults.workspaceImport, 'import versions'),
      },
      packageManifests: { workspaceExport: stringArray(packageManifests.workspaceExport, 'manifest versions') },
      embeddedResults: { externalReferenceCorrelations: [CMS_CORRELATION_CONTRACT] },
      compatibility: { 'workspaceExportSet@1': exportCompatibility, 'workspaceImport@1': importCompatibility },
    },
    capabilities: array(record.capabilities, 'capabilities').map(validateCapability),
  };
}

function validateExportConsistency(envelope: CmsEnvelope<CmsExportResult>): void {
  const result = envelope.result!;
  const workspaceIds = result.workspaces.map((workspace) => workspace.source.sourceId);
  requireUniqueCanonicalOrder(workspaceIds, 'workspace IDs');
  requireUniqueCanonicalOrder(
    result.externalReferenceCorrelations.map((row) => `${row.sourceWorkspaceId}\0${row.sourceReference}`),
    'correlation rows'
  );
  if (
    result.selection.selectedCount !== workspaceIds.length ||
    result.selection.discoveredCount < result.selection.selectedCount
  ) {
    throw contractError('selection counts must match workspaces');
  }
  const counts = {
    succeeded: result.workspaces.filter((workspace) => workspace.status === 'success').length,
    partial: result.workspaces.filter((workspace) => workspace.status === 'partial').length,
    failed: result.workspaces.filter((workspace) => workspace.status === 'failed' || workspace.status === 'blocked')
      .length,
  };
  if (
    result.summary.succeededCount !== counts.succeeded ||
    result.summary.partialCount !== counts.partial ||
    result.summary.failedCount !== counts.failed
  ) {
    throw contractError('summary counts must match workspace statuses');
  }
  const expectedStatus =
    counts.failed > 0
      ? counts.succeeded > 0 || counts.partial > 0
        ? 'partial'
        : 'failed'
      : counts.partial > 0
      ? 'partial'
      : 'success';
  if (envelope.status !== expectedStatus) throw contractError('export status must match summary');
  requireUnique(
    result.workspaces.map((workspace) => workspace.artifact.path),
    'artifact path'
  );
  requireUnique(
    result.workspaces.map((workspace) => workspace.artifact.manifestPath),
    'manifest path'
  );
}

function validateExportResult(value: unknown): CmsExportResult {
  const record = strictRecord(
    value,
    ['workspaceType', 'outputDirectory', 'selection', 'summary', 'externalReferenceCorrelations', 'workspaces'],
    'export result'
  );
  exact(record.workspaceType, 'Marketing', 'workspace type');
  const selection = strictRecord(record.selection, ['mode', 'discoveredCount', 'selectedCount'], 'selection');
  exact(selection.mode, 'all', 'selection mode');
  const summary = strictRecord(record.summary, ['succeededCount', 'partialCount', 'failedCount'], 'summary');
  return {
    workspaceType: 'Marketing',
    outputDirectory: string(record.outputDirectory, 'output directory'),
    selection: {
      mode: 'all',
      discoveredCount: integer(selection.discoveredCount, 'discovered count'),
      selectedCount: integer(selection.selectedCount, 'selected count'),
    },
    summary: {
      succeededCount: integer(summary.succeededCount, 'succeeded count'),
      partialCount: integer(summary.partialCount, 'partial count'),
      failedCount: integer(summary.failedCount, 'failed count'),
    },
    externalReferenceCorrelations: array(record.externalReferenceCorrelations, 'correlations').map(validateCorrelation),
    workspaces: array(record.workspaces, 'workspaces').map(validateWorkspace),
  };
}

function validateCorrelation(value: unknown): CmsExternalReferenceCorrelation {
  const record = strictRecord(
    value,
    ['sourceWorkspaceId', 'sourceReference', 'referenceKind', 'referenceId', 'packageManifestSha256'],
    'correlation'
  );
  return {
    sourceWorkspaceId: nonempty(record.sourceWorkspaceId, 'sourceWorkspaceId'),
    sourceReference: nonempty(record.sourceReference, 'sourceReference'),
    referenceKind: exactValue(record.referenceKind, CMS_REFERENCE_KIND, 'referenceKind'),
    referenceId: nonempty(record.referenceId, 'referenceId'),
    packageManifestSha256: sha256(record.packageManifestSha256, 'packageManifestSha256'),
  };
}

function validateWorkspace(value: unknown): CmsExportWorkspace {
  const record = strictRecord(value, ['source', 'status', 'artifact', 'diagnostics'], 'workspace');
  const source = strictRecord(record.source, ['kind', 'sourceId', 'name', 'workspaceType'], 'workspace source');
  exact(source.kind, 'cms.workspace', 'workspace source kind');
  exact(source.workspaceType, 'Marketing', 'workspace source type');
  const artifact = strictRecord(
    record.artifact,
    ['path', 'manifestPath', 'manifestContract', 'manifestContractVersion', 'manifestSha256'],
    'artifact'
  );
  exact(artifact.manifestContract, 'sf-cms-workspace-export', 'manifest contract');
  versionMajor(artifact.manifestContractVersion, 1, 'manifest contract version');
  return {
    source: {
      kind: 'cms.workspace',
      sourceId: nonempty(source.sourceId, 'sourceId'),
      name: nonempty(source.name, 'workspace name'),
      workspaceType: 'Marketing',
    },
    status: oneOf(record.status, ['success', 'partial', 'failed', 'blocked'] as const, 'workspace status'),
    artifact: {
      path: relativePath(artifact.path, 'artifact path'),
      manifestPath: relativePath(artifact.manifestPath, 'manifest path'),
      manifestContract: 'sf-cms-workspace-export',
      manifestContractVersion: string(artifact.manifestContractVersion, 'manifest contract version'),
      manifestSha256: sha256(artifact.manifestSha256, 'manifestSha256'),
    },
    diagnostics: validateDiagnostics(record.diagnostics),
  };
}

function validateDiagnostics(value: unknown): CmsDiagnostics {
  const record = strictRecord(value, ['warnings', 'errors'], 'diagnostics');
  return {
    warnings: array(record.warnings, 'warnings').map(validateDiagnostic),
    errors: array(record.errors, 'errors').map(validateDiagnostic),
  };
}

function validateDiagnostic(value: unknown): CmsDiagnostic {
  const record = strictRecord(value, ['code', 'message', 'scope', 'reference', 'retryable'], 'diagnostic', true);
  return {
    code: nonempty(record.code, 'diagnostic code'),
    message: nonempty(record.message, 'diagnostic message'),
    ...(record.scope === undefined ? {} : { scope: string(record.scope, 'diagnostic scope') }),
    ...(record.reference === undefined ? {} : { reference: string(record.reference, 'diagnostic reference') }),
    ...(record.retryable === undefined ? {} : { retryable: boolean(record.retryable, 'diagnostic retryable') }),
  };
}

function validateProvenance(value: unknown): CmsProvenance {
  const record = strictRecord(
    value,
    ['producer', 'sourceOrgId', 'pluginVersion', 'exportSetId', 'command', 'generatedAt'],
    'provenance',
    true,
    ['producer', 'sourceOrgId', 'pluginVersion', 'command', 'generatedAt']
  );
  exact(record.producer, CMS_PLUGIN_NAME, 'producer');
  return {
    producer: CMS_PLUGIN_NAME,
    sourceOrgId: nonempty(record.sourceOrgId, 'sourceOrgId'),
    pluginVersion: version(record.pluginVersion, 'provenance plugin version'),
    ...(record.exportSetId === undefined ? {} : { exportSetId: nonempty(record.exportSetId, 'exportSetId') }),
    command: nonempty(record.command, 'command'),
    generatedAt: nonempty(record.generatedAt, 'generatedAt'),
  };
}

function validatePlugin(value: unknown): { name: typeof CMS_PLUGIN_NAME; version: string } {
  const record = strictRecord(value, ['name', 'version'], 'plugin');
  exact(record.name, CMS_PLUGIN_NAME, 'plugin name');
  return { name: CMS_PLUGIN_NAME, version: version(record.version, 'plugin version') };
}

function validateCapability(value: unknown): CmsCapability {
  const record = strictRecord(value, ['id', 'state', 'transport', 'contract'], 'capability');
  exact(record.transport, 'cli-json', 'capability transport');
  return {
    id: nonempty(record.id, 'capability id'),
    state: oneOf(record.state, ['implemented', 'experimental', 'unavailable'] as const, 'capability state'),
    transport: 'cli-json',
    contract: nonempty(record.contract, 'capability contract'),
  };
}

function validateManifestCompatibility(value: unknown): { workspaceExportManifestMajors: number[] } {
  const record = strictRecord(value, ['workspaceExportManifestMajors'], 'manifest compatibility');
  return {
    workspaceExportManifestMajors: array(record.workspaceExportManifestMajors, 'manifest majors').map((item) =>
      integer(item, 'manifest major')
    ),
  };
}

function requiredCapability(
  capabilities: CmsCapability[],
  id: string,
  contract: string
): 'implemented' | 'experimental' {
  const matches = capabilities.filter((capability) => capability.id === id);
  if (matches.length !== 1) throw contractError(`required capability ${id}`);
  const capability = matches[0];
  if (capability.contract !== contract) throw contractError(`capability contract ${id}`);
  if (capability.state === 'unavailable') throw contractError(`capability unavailable ${id}`);
  return capability.state;
}

function strictRecord(
  value: unknown,
  keys: string[],
  label: string,
  optional = false,
  requiredKeys = keys.slice(0, 2)
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw contractError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const allowed = [...keys].sort();
  if (optional) {
    if (actual.some((key) => !allowed.includes(key)) || requiredKeys.some((key) => !actual.includes(key)))
      throw contractError(`${label} fields`);
  } else if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw contractError(`${label} fields`);
  }
  return record;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw contractError(`${label} must be an array`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item) => string(item, label));
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw contractError(`${label} must be a string`);
  return value;
}

function nonempty(value: unknown, label: string): string {
  const result = string(value, label);
  if (result.length === 0) throw contractError(`${label} must not be empty`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw contractError(`${label} must be a boolean`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw contractError(`${label} must be a non-negative integer`);
  return value as number;
}

function exact(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw contractError(`${label} must be ${expected}`);
}

function exactValue<const T extends string>(value: unknown, expected: T, label: string): T {
  exact(value, expected, label);
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw contractError(`${label} is unknown`);
  return value as T[number];
}

function version(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^\d+\.\d+\.\d+$/.test(result)) throw contractError(`${label} must be semantic version`);
  return result;
}

function versionMajor(value: unknown, expected: number, label: string): void {
  const result = version(value, label);
  if (Number(result.split('.')[0]) !== expected) throw contractError(`${label} major is unsupported`);
}

function requireMajor(versions: string[], expected: number, label: string): void {
  if (!versions.some((item) => Number(version(item, label).split('.')[0]) === expected))
    throw contractError(`${label} major is unsupported`);
}

function requireUniqueCanonicalOrder(values: string[], label: string): void {
  const sorted = [...values].sort((left, right) => left.localeCompare(right));
  if (new Set(values).size !== values.length) throw contractError(`${label} must be unique`);
  if (values.some((value, index) => value !== sorted[index]))
    throw contractError(`${label} must be canonically ordered`);
}

function requireUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw contractError(`duplicate ${label}`);
}

function isAtLeastVersion(actual: string, minimum: string): boolean {
  const left = version(actual, 'plugin version').split('.').map(Number);
  const right = minimum.split('.').map(Number);
  return (
    left.some(
      (part, index) =>
        part > right[index] && left.slice(0, index).every((prior, priorIndex) => prior === right[priorIndex])
    ) || left.every((part, index) => part === right[index])
  );
}

function sha256(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) throw contractError(`${label} must be lowercase SHA-256`);
  return result;
}

function relativePath(value: unknown, label: string): string {
  const result = nonempty(value, label);
  if (result.includes('\\') || result.startsWith('/') || /^[A-Za-z]:/.test(result) || result.split('/').includes('..'))
    throw contractError(`${label} must be confined relative POSIX path`);
  return result;
}

function contractError(message: string): CmsContractError {
  return new CmsContractError(`Invalid CMS contract: ${message}`);
}
