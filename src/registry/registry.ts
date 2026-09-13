import { McnType, Provider, SupportState } from './types.js';

/**
 * Single source of truth for Marketing Cloud Next capability ownership.
 *
 * A registered entry is not automatically supported. Commands and help must use
 * the explicit state and operations rather than infer support from membership.
 */
export const MCN_TYPES: McnType[] = [
  {
    name: 'marketSegmentMember',
    description: 'Computed segment membership exported through the MCN Connect API',
    provider: 'mcnext',
    state: 'implemented',
    operations: ['export'],
  },
  {
    name: 'listEmail',
    description: 'ListEmail send definitions stored as Salesforce records',
    provider: 'mcnext',
    state: 'conditional',
    operations: ['retrieve'],
    directory: 'listEmail',
    limitation: 'Read evidence exists; portable dependency resolution and safe deployment remain unproven.',
  },
  {
    name: 'identityResolution',
    description: 'Data 360 identity-resolution ruleset configuration and aggregate status',
    provider: 'mcnext',
    state: 'implemented',
    operations: ['list', 'retrieve', 'export'],
    directory: 'identityResolution',
    limitation: 'Configuration only; unified-profile row migration is not supported.',
  },
  {
    name: 'cmsContent',
    description: 'Generic CMS workspaces, content, variants, media, and publication',
    provider: 'cms-service',
    state: 'deferred',
    operations: [],
    limitation: 'Opaque deferred dependency until sf-plugin-cms publishes an approved public service contract.',
  },
  {
    name: 'flow',
    description: 'Marketing flows',
    provider: 'core-sf',
    state: 'delegated',
    operations: ['retrieve', 'deploy'],
    delegation: { metadataType: 'Flow' },
  },
  {
    name: 'flowDefinition',
    description: 'Flow definitions controlling active flow versions',
    provider: 'core-sf',
    state: 'delegated',
    operations: ['retrieve', 'deploy'],
    delegation: { metadataType: 'FlowDefinition' },
  },
  {
    name: 'flowTest',
    description: 'Flow tests',
    provider: 'core-sf',
    state: 'delegated',
    operations: ['retrieve', 'deploy'],
    delegation: { metadataType: 'FlowTest' },
  },
  {
    name: 'managedContentType',
    description: 'CMS content-type schemas, not content instances',
    provider: 'core-sf',
    state: 'delegated',
    operations: ['retrieve', 'deploy'],
    delegation: { metadataType: 'ManagedContentType' },
  },
  {
    name: 'contentTypeBundle',
    description: 'CMS content-type bundles',
    provider: 'core-sf',
    state: 'delegated',
    operations: ['retrieve', 'deploy'],
    delegation: { metadataType: 'ContentTypeBundle' },
  },
  {
    name: 'marketSegmentDefinition',
    description: 'Segment rule definitions, not computed membership',
    provider: 'core-sf',
    state: 'delegated',
    operations: ['retrieve', 'deploy'],
    delegation: { metadataType: 'MarketSegmentDefinition' },
  },
  {
    name: 'marketSegmentRecord',
    description: 'MarketSegment records and their segment/publish status',
    provider: 'core-sf',
    state: 'delegated',
    operations: ['export'],
    delegation: {
      sObject: 'MarketSegment',
      fields: ['Id', 'Name', 'MarketSegmentType', 'SegmentStatus', 'PublishStatus'],
    },
  },
];

/** Return registered capabilities, optionally filtered by provider or state. */
export function getTypes(filter?: { provider?: Provider; state?: SupportState }): McnType[] {
  return MCN_TYPES.filter(
    (type) =>
      (!filter?.provider || type.provider === filter.provider) && (!filter?.state || type.state === filter.state)
  );
}

/** Look up one capability by its CLI-facing name. */
export function getType(name: string): McnType | undefined {
  return MCN_TYPES.find((type) => type.name === name);
}
