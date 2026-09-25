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
    provider: 'core-sf',
    state: 'delegated',
    operations: ['retrieve'],
    directory: 'listEmail',
    delegation: { sObject: 'ListEmail', command: 'sf data get record --sobject ListEmail' },
    limitation: 'Exact record reads are public; portable dependency resolution and safe deployment remain unproven.',
  },
  {
    name: 'emailTemplate',
    description: 'Reusable email templates stored as Salesforce CMS content',
    provider: 'mcnext',
    state: 'implemented',
    operations: ['retrieve'],
    directory: 'emailTemplate',
    limitation: 'Exact read-only retrieval only; create, update, publication, variants, and migration are not supported.',
  },
  {
    name: 'campaign',
    description: 'Bounded Campaign configuration transported through core Salesforce CLI data commands',
    provider: 'mcnext',
    state: 'implemented',
    operations: ['retrieve', 'create', 'update'],
    directory: 'campaign',
    limitation: 'Selected scalar configuration only; members, sends, relationships, custom fields, and lifecycle are excluded.',
  },
  {
    name: 'dataGraph',
    description: 'Accessible Data 360 Data Graph metadata',
    provider: 'mcnext',
    state: 'implemented',
    operations: ['retrieve'],
    directory: 'dataGraph',
    limitation: 'Metadata GET only with an externally obtained Data 360 token; graph mutation and token exchange are excluded.',
  },
  {
    name: 'identityResolution',
    description: 'Data 360 identity-resolution ruleset configuration and aggregate status',
    provider: 'mcnext',
    state: 'implemented',
    operations: ['list', 'retrieve', 'export', 'plan'],
    directory: 'identityResolution',
    limitation:
      'Planning is GET-only and mutation-free; CREATE/PATCH schemas and lifecycle safety remain blocked, and unified-profile row migration is not supported.',
  },
  {
    name: 'cmsContent',
    description: 'Provider-owned CMS workspaces and content evidence for migration planning',
    provider: 'cms-service',
    state: 'conditional',
    operations: ['export'],
    limitation:
      'Capability discovery and aggregate export evidence can be consumed by sf mcnext migration plan --cms-plan through the separately installed sf-plugin-cms >=0.4.0 versioned CLI contract; MCN owns no CMS content retrieval, import, deployment, payload rewriting, or execution.',
  },
  {
    name: 'flow',
    description: 'Marketing flows with bounded public source operations over core Metadata API transport',
    provider: 'mcnext',
    state: 'implemented',
    operations: ['retrieve', 'create', 'update'],
    directory: 'flow',
    limitation: 'Selected inactive Flow source only; activation, runtime readiness, cross-org reference mapping, and lifecycle are excluded.',
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
    provider: 'mcnext',
    state: 'implemented',
    operations: ['create'],
    limitation:
      'Strict CREATE delegates validation, apply, and independent readback to Core; UPDATE, publication, scheduling, and automatic retry are not supported.',
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
