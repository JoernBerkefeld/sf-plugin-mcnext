import { createHash } from 'node:crypto';
import { redact } from '../cms/cmsCli.js';
import type {
  CmsCapabilitySelection,
  CmsDiagnostic,
  CmsExternalReferenceCorrelation,
  CmsStatus,
} from '../cms/contracts.js';
import type { ValidatedCmsPackage } from '../cms/packageIntegrity.js';

export const CMS_WORKSPACE_MAP_MAX_BYTES = 1_048_576;
export const CMS_WORKSPACE_MAP_MAX_ENTRIES = 1000;

export type CmsWorkspaceRoute = {
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
};

export type CmsWorkspaceMap = {
  version: 1;
  sha256: string;
  byteLength: number;
  routes: CmsWorkspaceRoute[];
};

export type CmsPlanningPrimaryState = 'ready-for-execution' | 'blocked' | 'partial' | 'failed' | 'ownership-uncertain';

export type CmsPlanningCapabilityEvidence = {
  pluginVersion: string;
  bulkExport: CmsCapabilitySelection['bulkExport'];
  externalReferenceCorrelation: CmsCapabilitySelection['externalReferenceCorrelation'];
  experimental: boolean;
};

export type CmsPlanningProvenance = {
  sourceOrgId: string;
  pluginVersion: string;
  exportSetId: string;
  command: string;
  generatedAt: string;
};

export type CmsPlanningPackageEvidence = Pick<
  ValidatedCmsPackage,
  'sourceWorkspaceId' | 'artifactPath' | 'manifestPath' | 'packageManifestSha256'
>;

export type CmsPlanningCorrelationEvidence = CmsExternalReferenceCorrelation;

export type CmsPlanningRouteEvidence = CmsWorkspaceRoute & {
  packageManifestSha256?: string;
  status: CmsStatus;
  state: Exclude<CmsPlanningPrimaryState, 'failed'>;
  experimental: boolean;
  diagnostics: CmsDiagnostic[];
};

type CmsPlanningStateBase = {
  kind: 'cms-planning-only';
  state: CmsPlanningPrimaryState;
  experimental: boolean;
  workspaceMap: Pick<CmsWorkspaceMap, 'version' | 'sha256' | 'byteLength'>;
  packages: CmsPlanningPackageEvidence[];
  correlations: CmsPlanningCorrelationEvidence[];
  routes: CmsPlanningRouteEvidence[];
  diagnostics: CmsDiagnostic[];
  executablePayloads: [];
  imports: [];
  rewrites: [];
  mutations: [];
};

export type CmsPlanningState =
  | (CmsPlanningStateBase & {
      state: Exclude<CmsPlanningPrimaryState, 'failed'>;
      capabilities: CmsPlanningCapabilityEvidence;
      exportProvenance: CmsPlanningProvenance;
    })
  | (CmsPlanningStateBase & { state: 'failed' });

export type CmsPlanningStateInput = {
  state: Exclude<CmsPlanningPrimaryState, 'failed'>;
  capabilities: CmsPlanningCapabilityEvidence;
  exportProvenance: CmsPlanningProvenance;
  workspaceMap: Pick<CmsWorkspaceMap, 'version' | 'sha256' | 'byteLength'>;
  packages: CmsPlanningPackageEvidence[];
  correlations?: CmsPlanningCorrelationEvidence[];
  routes: CmsPlanningRouteEvidence[];
  diagnostics?: CmsDiagnostic[];
};

export class CmsWorkspaceMapError extends Error {}

/** Parse the exact bounded workspace-map contract and retain exact-byte provenance. */
export function parseCmsWorkspaceMap(
  input: Buffer,
  limits: { maxBytes?: number; maxEntries?: number } = {}
): CmsWorkspaceMap {
  const maxBytes = positiveLimit(limits.maxBytes ?? CMS_WORKSPACE_MAP_MAX_BYTES, 'maxBytes');
  const maxEntries = positiveLimit(limits.maxEntries ?? CMS_WORKSPACE_MAP_MAX_ENTRIES, 'maxEntries');
  if (input.byteLength > maxBytes) throw mapError('input exceeds byte limit');

  const root = new JsonParser(input.toString('utf8')).parseObject('workspace map');
  exactKeys(root, ['version', 'workspaces'], 'workspace map');
  if (root.get('version') !== 1) throw mapError('version must be 1');
  const workspaces = root.get('workspaces');
  if (!(workspaces instanceof Map)) throw mapError('workspaces must be an object');
  if (workspaces.size === 0) throw mapError('workspaces must not be empty');
  if (workspaces.size > maxEntries) throw mapError('workspace entry limit exceeded');

  const targets = new Set<string>();
  const routes = [...workspaces.entries()].map(([sourceWorkspaceId, target]) => {
    const source = workspaceId(sourceWorkspaceId, 'source workspace ID');
    const targetWorkspaceId = workspaceId(target, 'target workspace ID');
    if (targets.has(targetWorkspaceId)) throw mapError(`duplicate target workspace route: ${targetWorkspaceId}`);
    targets.add(targetWorkspaceId);
    return { sourceWorkspaceId: source, targetWorkspaceId };
  });
  routes.sort((left, right) =>
    `${left.sourceWorkspaceId}\0${left.targetWorkspaceId}`.localeCompare(
      `${right.sourceWorkspaceId}\0${right.targetWorkspaceId}`
    )
  );
  return {
    version: 1,
    sha256: createHash('sha256').update(input).digest('hex'),
    byteLength: input.byteLength,
    routes,
  };
}

/** Build deterministic planning-only CMS evidence with mutation surfaces fixed empty. */
export function buildCmsPlanningState(input: CmsPlanningStateInput): CmsPlanningState {
  const packages = [...input.packages].sort((left, right) =>
    left.sourceWorkspaceId.localeCompare(right.sourceWorkspaceId)
  );
  const routes = [...input.routes]
    .map((route) => ({ ...route, diagnostics: sortDiagnostics(route.diagnostics) }))
    .sort((left, right) => left.sourceWorkspaceId.localeCompare(right.sourceWorkspaceId));
  const correlations = [...(input.correlations ?? [])].sort((left, right) =>
    `${left.sourceWorkspaceId}\0${left.sourceReference}`.localeCompare(
      `${right.sourceWorkspaceId}\0${right.sourceReference}`
    )
  );
  const packageHashes = new Map<string, string>();
  for (const item of packages) {
    if (packageHashes.has(item.sourceWorkspaceId)) {
      throw new CmsWorkspaceMapError(`CMS planning has duplicate package evidence: ${item.sourceWorkspaceId}`);
    }
    packageHashes.set(item.sourceWorkspaceId, item.packageManifestSha256);
  }
  const correlationSources = new Set<string>();
  for (const row of correlations) {
    const key = `${row.sourceWorkspaceId}\0${row.sourceReference}`;
    if (correlationSources.has(key)) throw new CmsWorkspaceMapError('CMS planning has duplicate correlation evidence');
    correlationSources.add(key);
    if (packageHashes.get(row.sourceWorkspaceId) !== row.packageManifestSha256) {
      throw new CmsWorkspaceMapError(`CMS planning correlation package mismatch: ${row.sourceWorkspaceId}`);
    }
  }
  const routedSources = new Set<string>();
  for (const route of routes) {
    if (routedSources.has(route.sourceWorkspaceId)) {
      throw new CmsWorkspaceMapError(`CMS planning has duplicate workspace route: ${route.sourceWorkspaceId}`);
    }
    routedSources.add(route.sourceWorkspaceId);
    if (route.packageManifestSha256 !== undefined) {
      const verifiedHash = packageHashes.get(route.sourceWorkspaceId);
      if (verifiedHash === undefined) {
        throw new CmsWorkspaceMapError(`CMS planning route has no verified package: ${route.sourceWorkspaceId}`);
      }
      if (verifiedHash !== route.packageManifestSha256) {
        throw new CmsWorkspaceMapError(`CMS planning route package mismatch: ${route.sourceWorkspaceId}`);
      }
    }
  }
  return {
    kind: 'cms-planning-only',
    state: input.state,
    experimental: input.capabilities.experimental || routes.some((route) => route.experimental),
    capabilities: { ...input.capabilities },
    exportProvenance: { ...input.exportProvenance },
    workspaceMap: { ...input.workspaceMap },
    packages,
    correlations,
    routes,
    diagnostics: sortDiagnostics(input.diagnostics ?? []),
    executablePayloads: [],
    imports: [],
    rewrites: [],
    mutations: [],
  };
}

/** Build a bounded failed state without fabricating capability or export provenance. */
export function buildFailedCmsPlanningState(
  workspaceMap: Pick<CmsWorkspaceMap, 'version' | 'sha256' | 'byteLength'>,
  diagnostic: CmsDiagnostic
): CmsPlanningState {
  return {
    kind: 'cms-planning-only',
    state: 'failed',
    experimental: false,
    workspaceMap: { ...workspaceMap },
    packages: [],
    correlations: [],
    routes: [],
    diagnostics: sortDiagnostics([diagnostic]),
    executablePayloads: [],
    imports: [],
    rewrites: [],
    mutations: [],
  };
}

function sortDiagnostics(diagnostics: CmsDiagnostic[]): CmsDiagnostic[] {
  return diagnostics
    .map((item) => ({
      code: redact(item.code),
      message: redact(item.message),
      ...(item.scope === undefined ? {} : { scope: redact(item.scope) }),
      ...(item.reference === undefined ? {} : { reference: redact(item.reference) }),
      ...(item.retryable === undefined ? {} : { retryable: item.retryable }),
    }))
    .sort((left, right) =>
      `${left.code}\0${left.scope ?? ''}\0${left.reference ?? ''}\0${left.message}`.localeCompare(
        `${right.code}\0${right.scope ?? ''}\0${right.reference ?? ''}\0${right.message}`
      )
    );
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw mapError(`${label} must be a positive integer`);
  return value;
}

function workspaceId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\0')) {
    throw mapError(`${label} must be a non-empty exact string`);
  }
  return value;
}

function exactKeys(record: Map<string, JsonValue>, expected: string[], label: string): void {
  const actual = [...record.keys()].sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw mapError(`${label} fields must be exactly ${expected.join(', ')}`);
  }
}

type JsonValue = string | number | boolean | null | Map<string, JsonValue> | JsonValue[];

class JsonParser {
  private index = 0;

  public constructor(private readonly source: string) {}

  public parseObject(label: string): Map<string, JsonValue> {
    this.space();
    const result = this.object(label);
    this.space();
    if (this.index !== this.source.length) throw mapError('input must contain exactly one JSON value');
    return result;
  }

  private value(label: string): JsonValue {
    this.space();
    const current = this.source[this.index];
    if (current === '{') return this.object(label);
    if (current === '[') return this.array(label);
    if (current === '"') return this.string();
    if (current === '-' || (current >= '0' && current <= '9')) return this.number();
    for (const [literal, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.source.startsWith(literal, this.index)) {
        this.index += literal.length;
        return value;
      }
    }
    throw mapError(`${label} contains invalid JSON`);
  }

  private object(label: string): Map<string, JsonValue> {
    this.expect('{');
    const result = new Map<string, JsonValue>();
    this.space();
    if (this.take('}')) return result;
    for (;;) {
      this.space();
      if (this.source[this.index] !== '"') throw mapError(`${label} object key must be a string`);
      const key = this.string();
      if (result.has(key)) throw mapError(`duplicate JSON key: ${key}`);
      this.space();
      this.expect(':');
      result.set(key, this.value(label));
      this.space();
      if (this.take('}')) return result;
      this.expect(',');
    }
  }

  private array(label: string): JsonValue[] {
    this.expect('[');
    const result: JsonValue[] = [];
    this.space();
    if (this.take(']')) return result;
    for (;;) {
      result.push(this.value(label));
      this.space();
      if (this.take(']')) return result;
      this.expect(',');
    }
  }

  private string(): string {
    const start = this.index;
    this.expect('"');
    let escaped = false;
    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === '"' && !escaped) {
        try {
          return JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          throw mapError('invalid JSON string');
        }
      }
      if (!escaped && character.charCodeAt(0) < 0x20) throw mapError('invalid JSON string');
      escaped = !escaped && character === '\\';
      if (character !== '\\') escaped = false;
    }
    throw mapError('unterminated JSON string');
  }

  private number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.source.slice(this.index));
    if (!match) throw mapError('invalid JSON number');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw mapError('invalid JSON number');
    return value;
  }

  private space(): void {
    while (/\s/u.test(this.source[this.index] ?? '')) this.index += 1;
  }

  private take(character: string): boolean {
    if (this.source[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private expect(character: string): void {
    if (!this.take(character)) throw mapError(`expected ${character}`);
  }
}

function mapError(message: string): CmsWorkspaceMapError {
  return new CmsWorkspaceMapError(`Invalid CMS workspace map: ${message}`);
}
