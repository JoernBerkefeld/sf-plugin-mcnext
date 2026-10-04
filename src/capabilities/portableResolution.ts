import {
  assertPortableIdentity,
  type JsonValue,
  type PortableIdentity,
  type ServerIdentity,
  type StrategyDeclaration,
} from './contracts.js';
import { lookupMcnCapability } from './registry.js';

export type CompletionEvidence = {
  strategy: StrategyDeclaration['strategy'];
  completionProof: string;
  calls: number;
  items: number;
  pages: number;
  complete: boolean;
};

export type ResolvedPortableIdentity<Evidence> = {
  portableIdentity: PortableIdentity;
  evidenceIdentity: ServerIdentity;
  evidence: Evidence;
};

export type CampaignObservation = {
  serverId: string;
  portableName: string;
  context: Record<string, JsonValue>;
  relationships: {
    ParentId: string | null;
    RecordTypeId: string | null;
    BriefId: string | null;
    CampaignImageId: string | null;
    CampaignMemberRecordTypeId: string | null;
  };
};

export type CampaignResolutionInput = {
  portableName: string;
  context: Record<string, JsonValue>;
  records: CampaignObservation[];
  totalSize: number;
  queryDone: boolean;
  completion: CompletionEvidence;
};

export type DataSpaceObservation = {
  serverId: string;
  DataSpaceApiName: string | null;
};

export type DataSpaceResolutionInput = {
  DataSpaceApiName: string;
  records: DataSpaceObservation[];
  totalSize: number;
  queryDone: boolean;
  completion: CompletionEvidence;
};

const campaignIdentity = {
  provider: 'sf-plugin-mcnext',
  family: 'mcnext',
  type: 'Campaign',
  profile: 'relationship-free-scalar-resolver',
} as const;
const dataSpaceIdentity = {
  provider: 'sf-plugin-mcnext',
  family: 'mcnext',
  type: 'Data Space',
  profile: 'scope-identity-resolver',
} as const;

/** Resolve a uniquely evidenced relationship-free Campaign observation into portable identity. */
export function resolveCampaignPortableIdentity(
  input: CampaignResolutionInput
): ResolvedPortableIdentity<{ observation: CampaignObservation; completion: CompletionEvidence }> {
  const declaration = requireDeclaration(campaignIdentity);
  requireNonempty(input.portableName, 'Campaign portable name');
  assertCompleteInventory(input.records, input.totalSize, input.queryDone, 'Campaign');
  const matches = input.records.filter(
    (record) => record.portableName === input.portableName && equalJson(record.context, input.context)
  );
  if (matches.length !== 1) throw new Error('Campaign portable name and context must resolve uniquely');
  assertCompletion(input.completion, declaration.retrieval, input.records.length, 'Campaign');
  const observation = matches[0];
  if (Object.values(observation.relationships).some((value) => value !== null)) {
    throw new Error('Campaign relationships are unavailable for the relationship-free scalar profile');
  }
  requireSalesforceId(observation.serverId, 'Campaign server ID');

  const portableIdentity: PortableIdentity = {
    family: 'mcnext',
    type: 'Campaign',
    apiName: input.portableName,
    context: input.context,
  };
  assertPortableIdentity(portableIdentity);
  return {
    portableIdentity,
    evidenceIdentity: { kind: 'salesforce-id', value: observation.serverId },
    evidence: { observation, completion: input.completion },
  };
}

/** Resolve Data Space only as exact API-name scope identity, never as definition transport. */
export function resolveDataSpacePortableIdentity(
  input: DataSpaceResolutionInput
): ResolvedPortableIdentity<{ observation: DataSpaceObservation; completion: CompletionEvidence }> {
  const declaration = requireDeclaration(dataSpaceIdentity);
  requireNonempty(input.DataSpaceApiName, 'DataSpace API name');
  assertCompleteInventory(input.records, input.totalSize, input.queryDone, 'Data Space');
  assertCompletion(input.completion, declaration.retrieval, input.records.length, 'Data Space');
  if (input.records.some((record) => !record.DataSpaceApiName)) {
    throw new Error('Every Data Space observation must include DataSpaceApiName');
  }
  const matches = input.records.filter((record) => record.DataSpaceApiName === input.DataSpaceApiName);
  if (matches.length !== 1) throw new Error('DataSpaceApiName must resolve uniquely');
  const observation = matches[0];
  requireSalesforceId(observation.serverId, 'Data Space server ID');

  const portableIdentity: PortableIdentity = {
    family: 'mcnext',
    type: 'Data Space',
    apiName: input.DataSpaceApiName,
  };
  assertPortableIdentity(portableIdentity);
  return {
    portableIdentity,
    evidenceIdentity: {
      kind: 'exact-scope',
      value: input.DataSpaceApiName,
      scope: { serverRecordId: observation.serverId },
    },
    evidence: { observation, completion: input.completion },
  };
}

function requireDeclaration(
  identity: typeof campaignIdentity | typeof dataSpaceIdentity
): import('./contracts.js').CapabilityDeclaration {
  const result = lookupMcnCapability(identity);
  if (!result.available) throw new Error(`Capability unavailable: ${result.reason}`);
  return result.declaration;
}

function assertCompleteInventory(records: unknown[], totalSize: number, queryDone: boolean, label: string): void {
  if (!queryDone || !Number.isSafeInteger(totalSize) || totalSize !== records.length) {
    throw new Error(`${label} SOQL completion evidence is incomplete`);
  }
}

function assertCompletion(
  actual: CompletionEvidence,
  declared: StrategyDeclaration,
  itemCount: number,
  label: string
): void {
  if (
    actual.strategy !== declared.strategy ||
    actual.completionProof !== declared.completionProof ||
    actual.complete !== true
  ) {
    throw new Error(`${label} declaration strategy or completion proof does not match`);
  }
  if (actual.items !== itemCount) throw new Error(`${label} completion item count does not match evidence`);
  for (const key of ['calls', 'items', 'pages'] as const) {
    const value = actual[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > declared.hardBounds[`max${capitalize(key)}`]) {
      throw new Error(`${label} ${key} exceeds declared hard bounds`);
    }
  }
}

function capitalize(value: 'calls' | 'items' | 'pages'): 'Calls' | 'Items' | 'Pages' {
  return `${value[0].toUpperCase()}${value.slice(1)}` as 'Calls' | 'Items' | 'Pages';
}

function equalJson(left: Record<string, JsonValue>, right: Record<string, JsonValue>): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortJson(value[key])])
  ) as JsonValue;
}

function requireNonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required`);
}

function requireSalesforceId(value: string, label: string): void {
  if (!/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value)) throw new Error(`${label} is invalid`);
}
