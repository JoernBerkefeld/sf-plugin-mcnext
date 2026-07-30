import { Coverage, McnType } from './types.js';

/**
 * The single source of truth for what this plugin knows about.
 *
 * The `coverage` field drives three things at once, so they cannot drift apart:
 * which types `--gap-only` touches, what the provenance table prints, and the
 * support matrix generated into the README.
 *
 * Handlers are attached in a later step; entries listed here without a handler
 * are declared but not yet implemented.
 */
export const MCN_TYPES: McnType[] = [
  {
    name: 'emailContent',
    description: 'CMS email content items and their variants',
    coverage: 'gap',
    directory: 'emailContent',
  },
  {
    name: 'emailTemplate',
    description: 'CMS email templates',
    coverage: 'gap',
    directory: 'emailTemplate',
  },
  {
    name: 'cmsWorkspace',
    description: 'CMS workspaces (spaces) and their channel assignments',
    coverage: 'gap',
    directory: 'cmsWorkspace',
  },
  {
    name: 'listEmail',
    description: 'ListEmail send definitions, keyed by the package-name@version convention',
    coverage: 'gap',
    directory: 'listEmail',
  },
  {
    name: 'identityResolution',
    description: 'Data 360 identity-resolution rulesets (pending auth confirmation, see probe Q10)',
    coverage: 'gap',
    directory: 'identityResolution',
  },
  {
    name: 'flow',
    description: 'Marketing flows and their definitions',
    coverage: 'core-sf',
    directory: 'flows',
    delegation: { metadataType: 'Flow' },
  },
  {
    name: 'flowDefinition',
    description: 'Flow definitions controlling the active flow version',
    coverage: 'core-sf',
    directory: 'flowDefinitions',
    delegation: { metadataType: 'FlowDefinition' },
  },
  {
    name: 'flowTest',
    description: 'Flow tests',
    coverage: 'core-sf',
    directory: 'flowTests',
    delegation: { metadataType: 'FlowTest' },
  },
  {
    name: 'managedContentType',
    description: 'CMS content type schemas (not the content itself)',
    coverage: 'core-sf',
    directory: 'managedContentTypes',
    delegation: { metadataType: 'ManagedContentType' },
  },
  {
    name: 'contentTypeBundle',
    description: 'CMS content type bundles',
    coverage: 'core-sf',
    directory: 'contentTypeBundles',
    delegation: { metadataType: 'ContentTypeBundle' },
  },
  {
    name: 'marketSegmentDefinition',
    description: 'Segment definitions (the rules), not segment membership',
    coverage: 'core-sf',
    directory: 'marketSegmentDefinitions',
    delegation: { metadataType: 'MarketSegmentDefinition' },
  },
  {
    name: 'marketSegmentRecord',
    description: 'MarketSegment records (name, type, status) as data rows',
    coverage: 'core-sf',
    directory: 'records',
    delegation: {
      sObject: 'MarketSegment',
      fields: ['Id', 'Name', 'MarketSegmentType', 'Status'],
    },
  },
];

/**
 * Return the registered types, optionally filtered by coverage.
 *
 * @param [coverage] - restrict to one coverage bucket
 * @returns the matching type definitions
 */
export function getTypes(coverage?: Coverage): McnType[] {
  return coverage ? MCN_TYPES.filter((type) => type.coverage === coverage) : MCN_TYPES;
}

/**
 * Look up a single type by its CLI-facing name.
 *
 * @param name - the type name
 * @returns the type definition, or `undefined` when unknown
 */
export function getType(name: string): McnType | undefined {
  return MCN_TYPES.find((type) => type.name === name);
}
