import { assertCapabilityDeclaration, type CapabilityDeclaration } from './contracts.js';

export type CapabilityLookup = CapabilityDeclaration['identity'];

export type CapabilityUnavailableReason =
  | 'campaign-relationships-unavailable'
  | 'flow-unavailable'
  | 'standalone-data-graph-unavailable'
  | 'market-segment-unavailable'
  | 'market-segment-definition-unavailable'
  | 'unknown-profile';

export type CapabilityLookupResult =
  | { available: true; declaration: CapabilityDeclaration }
  | { available: false; identity: CapabilityLookup; reason: CapabilityUnavailableReason };

const declarations = [
  {
    dependencyExtractorVersion: 'mcnext-campaign-scalar@1',
    identity: {
      family: 'mcnext',
      profile: 'relationship-free-scalar-resolver',
      provider: 'sf-plugin-mcnext',
      type: 'Campaign',
    },
    nativeScope: { kind: 'salesforce-org', root: 'Campaign' },
    operations: ['retrieve', 'resolve'],
    preflight: {
      completionProof: 'exact API-name resolution with no relationship transport',
      hardBounds: { maxCalls: 5, maxItems: 1, maxPages: 1 },
      strategy: 'targeted',
    },
    providerContract: {
      // Package compatibility is independent of the metadata contract major.
      maxVersion: '0.9.999',
      minVersion: '0.8.0',
      name: 'sf-plugin-mcnext',
    },
    retrieval: {
      completionProof: 'exact scalar record match',
      hardBounds: { maxCalls: 5, maxItems: 1, maxPages: 1 },
      strategy: 'targeted',
    },
  },
  {
    dependencyExtractorVersion: 'mcnext-data-space-scalar@1',
    identity: {
      family: 'mcnext',
      profile: 'scope-identity-resolver',
      provider: 'sf-plugin-mcnext',
      type: 'Data Space',
    },
    nativeScope: { kind: 'salesforce-org', root: 'DataSpace' },
    operations: ['retrieve', 'resolve'],
    preflight: {
      completionProof: 'exact API-name scope resolution',
      hardBounds: { maxCalls: 5, maxItems: 1, maxPages: 1 },
      strategy: 'targeted',
    },
    providerContract: {
      // Package compatibility is independent of the metadata contract major.
      maxVersion: '0.9.999',
      minVersion: '0.8.0',
      name: 'sf-plugin-mcnext',
    },
    retrieval: {
      completionProof: 'complete bounded Data Space inventory',
      hardBounds: { maxCalls: 10, maxItems: 100, maxPages: 5 },
      strategy: 'retrieve-all',
    },
  },
] as const satisfies readonly CapabilityDeclaration[];

for (const declaration of declarations) assertCapabilityDeclaration(declaration);

function lookupKey(identity: CapabilityLookup): string {
  return `${identity.provider}\0${identity.family}\0${identity.type}\0${identity.profile}`;
}

const declarationsByKey = new Map<string, CapabilityDeclaration>(
  declarations.map((declaration) => [lookupKey(declaration.identity), declaration])
);

/** Resolve one exact MCNext-native declaration without inferring support from other inventories. */
export function lookupMcnCapability(identity: CapabilityLookup): CapabilityLookupResult {
  const declaration = declarationsByKey.get(lookupKey(identity));
  if (declaration) return { available: true, declaration };

  let reason: CapabilityUnavailableReason = 'unknown-profile';
  if (identity.type === 'Flow') reason = 'flow-unavailable';
  else if (identity.type === 'Data Graph') reason = 'standalone-data-graph-unavailable';
  else if (identity.type === 'MarketSegment') reason = 'market-segment-unavailable';
  else if (identity.type === 'MarketSegmentDefinition') reason = 'market-segment-definition-unavailable';
  else if (identity.type === 'Campaign' && identity.profile !== 'relationship-free-scalar-resolver') {
    reason = 'campaign-relationships-unavailable';
  }

  return { available: false, identity, reason };
}
