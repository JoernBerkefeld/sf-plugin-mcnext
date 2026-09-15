import { writeFile } from 'node:fs/promises';
import { Org } from '@salesforce/core';
import { TESTED_API_VERSION } from '../client/mcnClient.js';
import { FormatWriter } from '../format/formatWriter.js';
import type { CmsPlanningState } from './cmsPlanning.js';

export type MigrationOwner = 'core-sf' | 'mcnext' | 'cms-service' | 'external/manual' | 'secondary-data';
export type MigrationStatus =
  | 'automated'
  | 'delegated'
  | 'manual prerequisite'
  | 'conditional'
  | 'unsupported'
  | 'deferred';

export type MigrationInventoryItem = {
  key: string;
  owner: MigrationOwner;
  transport: string;
  classification: 'configuration' | 'secondary-data';
  status: MigrationStatus;
  sourceSelection: string;
  targetPrerequisite: string;
  dependencies: string[];
  evidence: string;
  limitation?: string;
};

export type OpaqueCmsDependency = {
  owner: 'cms-service';
  status: 'deferred: cms-service-contract';
  sourceReference: string;
  blockedOperation: string;
};

export type PreflightCheck = {
  key: string;
  status: 'pass' | 'manual' | 'blocked';
  message: string;
};

export type MigrationPlan = {
  schemaVersion: 1;
  mode: 'read-only';
  testedApiVersion: typeof TESTED_API_VERSION;
  sourceOrgId: string;
  targetOrgId: string;
  executableTargetPayloads: [];
  preflight: PreflightCheck[];
  inventory: MigrationInventoryItem[];
  deferredCmsDependencies: OpaqueCmsDependency[];
  cmsPlanning?: CmsPlanningState;
};

const INVENTORY: MigrationInventoryItem[] = [
  inventory(
    'accountConfiguration',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected Account customizations',
    'Account and required features available',
    [],
    'Core metadata transport identified',
    'Representative retrieval and target acceptance are not retained'
  ),
  inventory(
    'authenticatedSendingDomains',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Authenticated and sending domain requirements',
    'Domains authenticated in the target',
    [],
    'Target-specific setup is non-portable'
  ),
  inventory(
    'briefConfiguration',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected Brief object customizations',
    'Brief available in target',
    [],
    'Candidate core metadata transport',
    'Exact metadata members and target acceptance are not retained'
  ),
  inventory(
    'briefRecords',
    'mcnext',
    'core sf data with MCN planning',
    'conditional',
    'Selected Brief records',
    'Stable external keys and target-local relationships',
    ['briefConfiguration'],
    'Candidate core data transport',
    'Import, mapping, and no-op evidence are not retained'
  ),
  inventory(
    'businessUnitReferences',
    'mcnext',
    'MCN planning and target-local mapping',
    'conditional',
    'Business-unit references on selected artifacts',
    'Matching target business-unit context',
    [],
    'Inventory requirement only',
    'Portable identity and write behavior are unproven'
  ),
  inventory(
    'calculatedInsights',
    'mcnext',
    'unproven Data 360 transport',
    'conditional',
    'Selected calculated insight definitions',
    'Referenced DLO/DMO objects and fields available',
    ['dloSchemaDefinitions', 'dmoSchemaDefinitions'],
    'Documented coverage candidate only',
    'Retrieval, write, and no-op evidence are not retained'
  ),
  inventory(
    'campaignConfiguration',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected Campaign customizations',
    'Campaign available in target',
    [],
    'Core metadata transport identified',
    'Representative retrieval and target acceptance are not retained'
  ),
  inventory(
    'campaignRecords',
    'mcnext',
    'core sf data with MCN planning',
    'conditional',
    'Selected Campaign records',
    'Stable external keys and target-local relationships',
    ['campaignConfiguration'],
    'Candidate core data transport',
    'Import, mapping, and no-op evidence are not retained'
  ),
  inventory(
    'cmsArtifacts',
    'cms-service',
    'future published sf-plugin-cms service',
    'deferred',
    'Opaque source references only',
    'Published approved CMS service contract',
    [],
    'V2 ownership boundary',
    'No CMS payload inspection, mapping, lifecycle, rewriting, or deployment'
  ),
  inventory(
    'communicationSubscriptions',
    'mcnext',
    'unproven MCN product-record transport',
    'conditional',
    'Selected communication subscription definitions',
    'Channel types, policies, and target context available',
    ['engagementChannelTypes', 'subscriptionChannelTypes', 'consentPolicies'],
    'Inventory requirement only',
    'Retrieval, write, mapping, and no-op evidence are not retained'
  ),
  inventory(
    'connectors',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Required connector inventory',
    'Connectors installed and configured in target',
    [],
    'Connector setup is target-specific'
  ),
  inventory(
    'consentHistoryRows',
    'secondary-data',
    'unproven secondary-data transport',
    'deferred',
    'Explicitly selected consent history rows',
    'Consent definitions stable; retention, keys, scale, and provenance agreed',
    ['consentPolicies'],
    'Optional secondary-data boundary',
    'Not equivalent to consent-definition migration'
  ),
  inventory(
    'consentPolicies',
    'mcnext',
    'unproven MCN/Data 360 transport',
    'conditional',
    'Selected consent policy definitions',
    'Required channel and subscription definitions available',
    ['engagementChannelTypes', 'subscriptionChannelTypes'],
    'Inventory requirement only',
    'Exact transport and safe writes are unproven'
  ),
  inventory(
    'contactConfiguration',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected Contact customizations',
    'Contact and required features available',
    [],
    'Core metadata transport identified',
    'Representative retrieval and target acceptance are not retained'
  ),
  inventory(
    'corsOrigins',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Concrete CorsWhitelistOrigin dependencies',
    'Target browser origins approved',
    [],
    'Candidate core metadata transport',
    'Exact members and target acceptance are not retained'
  ),
  inventory(
    'credentials',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Credential requirements without secret values',
    'Target credentials created and verified',
    [],
    'Secrets and credentials are non-portable'
  ),
  inventory(
    'cspTrustedSites',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Concrete CspTrustedSite dependencies',
    'Target content and image domains approved',
    [],
    'Candidate core metadata transport',
    'Exact members and target acceptance are not retained'
  ),
  inventory(
    'customObjectConfiguration',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected custom object definitions',
    'Referenced objects available',
    [],
    'Core metadata transport identified',
    'Representative retrieval and target acceptance are not retained'
  ),
  inventory(
    'customObjectChildMetadata',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected fields, compact layouts, field sets, list views, validation rules, and web links',
    'Owning objects and referenced fields available',
    ['customObjectConfiguration'],
    'Candidate core metadata transport',
    'Representative dependency ordering and target acceptance are not retained'
  ),
  inventory(
    'customerRows',
    'secondary-data',
    'core sf data where sufficient',
    'deferred',
    'Explicitly selected CRM customer rows',
    'Definitions stable; scale, keys, relationships, and provenance agreed',
    ['accountConfiguration', 'contactConfiguration', 'leadConfiguration'],
    'Optional secondary-data increment',
    'Not configuration-definition migration'
  ),
  inventory(
    'dashboardFolders',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected dashboard folders',
    'Target folder access available',
    [],
    'Candidate core metadata transport',
    'Folder acceptance is not retained'
  ),
  inventory(
    'dashboards',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected dashboards',
    'Folders, source reports, and running users reconciled',
    ['dashboardFolders', 'reports'],
    'Candidate core metadata transport',
    'Representative target acceptance is not retained'
  ),
  inventory(
    'data360DataGraphs',
    'mcnext',
    'unproven Data 360 transport',
    'conditional',
    'Selected data graph definitions',
    'Referenced schema, mappings, and data space available',
    ['dloDmoMappings', 'dloSchemaDefinitions', 'dmoSchemaDefinitions'],
    'Documented coverage candidate only',
    'Retrieval, write, and no-op evidence are not retained'
  ),
  inventory(
    'data360DataKits',
    'mcnext',
    'unproven Data 360 transport',
    'conditional',
    'Selected data kit definitions',
    'Data space, products, permissions, and dependencies available',
    ['dataSpaces', 'productLicenses'],
    'Documented coverage candidate only',
    'Additional authentication or unsupported writes may keep this manual'
  ),
  inventory(
    'data360DataStreams',
    'mcnext',
    'unproven Data 360 transport',
    'conditional',
    'Selected data stream definitions',
    'Data space, connector, credential, and permissions available',
    ['connectors', 'credentials', 'dataSpaces', 'targetPermissions'],
    'Documented coverage candidate only',
    'Connector setup and writes are unproven'
  ),
  inventory(
    'dataSpaces',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Required data-space inventory',
    'Target data spaces provisioned and identifiers reconciled',
    [],
    'Target provisioning is non-portable'
  ),
  inventory(
    'dependentPicklists',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected controlling and dependent picklist fields',
    'Controlling fields and value sets available',
    ['globalValueSets', 'localValueSets'],
    'Dependency-closure requirement only',
    'Ordering and target acceptance are not retained'
  ),
  inventory(
    'dloDmoMappings',
    'mcnext',
    'unproven Data 360 transport',
    'conditional',
    'Selected DLO-to-DMO mapping definitions',
    'Referenced DLO and DMO schemas available',
    ['dloSchemaDefinitions', 'dmoSchemaDefinitions'],
    'Documented coverage candidate only',
    'Retrieval, write, and no-op evidence are not retained'
  ),
  inventory(
    'dloSchemaDefinitions',
    'mcnext',
    'unproven Data 360 transport',
    'conditional',
    'Selected DLO schema definitions',
    'Data space and source prerequisites available',
    ['dataSpaces'],
    'Documented coverage candidate only',
    'Distinct from CRM CustomObject metadata; writes are unproven'
  ),
  inventory(
    'dmoRows',
    'secondary-data',
    'unproven high-volume data transport',
    'deferred',
    'Explicitly selected DMO rows',
    'DMO definitions stable; scale, keys, and provenance agreed',
    ['dmoSchemaDefinitions'],
    'Optional secondary-data boundary',
    'Not equivalent to DMO schema migration'
  ),
  inventory(
    'dmoSchemaDefinitions',
    'mcnext',
    'unproven Data 360 transport',
    'conditional',
    'Selected DMO schema definitions',
    'Data space and model prerequisites available',
    ['dataSpaces'],
    'Documented coverage candidate only',
    'Distinct from CRM CustomObject metadata; writes are unproven'
  ),
  inventory(
    'dnsVerification',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Required DNS records and verification state',
    'DNS changes completed and verified externally',
    ['authenticatedSendingDomains'],
    'DNS control is external and non-portable'
  ),
  inventory(
    'engagementChannelTypes',
    'mcnext',
    'unproven MCN product-record transport',
    'conditional',
    'Selected engagement channel type definitions',
    'Product enablement and target channel support',
    ['productLicenses'],
    'Inventory requirement only',
    'Exact transport and safe writes are unproven'
  ),
  inventory(
    'fieldReferenceClosure',
    'core-sf',
    'selection and candidate sf project retrieve/deploy',
    'conditional',
    'Lookup, master-detail, and formula references from selected fields',
    'Referenced objects and fields included or present',
    ['customObjectConfiguration'],
    'Dependency-closure requirement only',
    'Generic dependency execution is not implemented'
  ),
  inventory(
    'flexiPages',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected Lightning FlexiPage members',
    'Referenced fields, components, and record types available',
    ['layouts', 'recordTypes'],
    'Candidate core metadata transport',
    'Representative target acceptance is not retained'
  ),
  inventory(
    'flows',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected evidenced MCN flows',
    'Campaigns, segments, schemas, permissions, and target setup available',
    ['campaignConfiguration', 'marketSegmentDefinition', 'targetPermissions'],
    'Core Flow metadata transport identified',
    'MCN selection rule and representative target acceptance are not retained'
  ),
  inventory(
    'globalValueSets',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Referenced GlobalValueSet members',
    'Target names and dependent fields reconciled',
    [],
    'Candidate core metadata transport',
    'Representative dependency ordering and target acceptance are not retained'
  ),
  inventory(
    'identityResolution',
    'mcnext',
    'MCN REST v67 read only',
    'conditional',
    'Ruleset configuration IDs',
    'Data space, DMO schema, and permissions available',
    ['dataSpaces', 'dmoSchemaDefinitions', 'targetPermissions'],
    'v0.1.0 proves read-only configuration retrieval only',
    'No deploy evidence'
  ),
  inventory(
    'landingPageExternalFormFraming',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Clickjack trusted domains required for external-form framing',
    'Trusted domains approved and configured in target session settings',
    ['landingPageSites'],
    'Framing trust is target-specific',
    'Exact metadata or API transport is unproven'
  ),
  inventory(
    'landingPageSites',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Marketing Landing Pages site requirements',
    'Sites provisioned, published, and associated with target context',
    ['businessUnitReferences', 'dataSpaces'],
    'Site provisioning and publication are target-specific',
    'CMS-owned page lifecycle remains excluded'
  ),
  inventory(
    'layouts',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected Layout members',
    'Referenced fields and record types available',
    ['recordTypes'],
    'Candidate core metadata transport',
    'Representative target acceptance is not retained'
  ),
  inventory(
    'leadConfiguration',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected Lead customizations',
    'Lead and required features available',
    [],
    'Core metadata transport identified',
    'Representative retrieval and target acceptance are not retained'
  ),
  inventory(
    'listEmailConfiguration',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected ListEmail object customizations',
    'ListEmail available in target',
    [],
    'Candidate core metadata transport',
    'Exact metadata members and target acceptance are not retained'
  ),
  inventory(
    'listEmailRecords',
    'mcnext',
    'core sf data plus MCN planning',
    'deferred',
    'Selected ListEmail records',
    'Target-local campaign, segment, and CMS content references',
    ['campaignRecords', 'listEmailConfiguration', 'marketSegmentRecords'],
    'Read evidence only',
    'CMS-linked operations stop until the public CMS service contract exists'
  ),
  inventory(
    'localValueSets',
    'core-sf',
    'selected CustomField metadata via candidate sf project retrieve/deploy',
    'conditional',
    'Referenced field-local picklist values',
    'Owning fields and dependent picklists selected',
    [],
    'Dependency-closure requirement only',
    'Representative dependency ordering and target acceptance are not retained'
  ),
  inventory(
    'managedContentSchema',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'ManagedContentType and ContentTypeBundle members',
    'Metadata types enabled in target',
    [],
    'Core metadata transport identified; schemas only',
    'Representative schema members and target acceptance are not retained'
  ),
  inventory(
    'managedPackages',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Required managed-package inventory',
    'Required packages installed and configured in target',
    [],
    'Package installation and configuration are target-specific'
  ),
  inventory(
    'marketSegmentDefinition',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected MarketSegmentDefinition members',
    'Data 360 and segmentation enabled',
    ['dataSpaces', 'dmoSchemaDefinitions'],
    'Core metadata transport identified',
    'Representative members and target acceptance are not retained'
  ),
  inventory(
    'marketSegmentObjectFieldConfiguration',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected MarketSegment object and field configuration',
    'MarketSegment object, fields, and referenced values available',
    ['dataSpaces', 'dmoSchemaDefinitions'],
    'Candidate core metadata transport',
    'Exact members, dependency ordering, and target acceptance are not retained'
  ),
  inventory(
    'marketSegmentRecords',
    'mcnext',
    'core sf data with MCN planning',
    'conditional',
    'Selected MarketSegment records',
    'Target-local dependencies and stable external-key strategy',
    ['marketSegmentDefinition', 'marketSegmentObjectFieldConfiguration'],
    'v0.1.0 proves export delegation only',
    'Import, mapping, and no-op evidence are not retained'
  ),
  inventory(
    'physicalAddresses',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Required physical mailing addresses',
    'Approved addresses configured in target',
    [],
    'Compliance data requires target review and is non-portable'
  ),
  inventory(
    'prospectIdentity',
    'external/manual',
    'no proven portable identity transport',
    'unsupported',
    'Unresolved Prospect identity references',
    'Prospect identity mapping explicitly resolved for the target',
    [],
    'Unresolved identity is an explicit migration blocker',
    'No portable identity or automated mapping contract is proven'
  ),
  inventory(
    'productLicenses',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Required product enablement and license inventory',
    'Products enabled and licenses assigned in target',
    [],
    'Product provisioning and licenses are non-portable'
  ),
  inventory(
    'recordTypes',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected record types and business processes',
    'Referenced objects and business processes available',
    ['customObjectConfiguration'],
    'Candidate core metadata transport',
    'Representative dependency ordering and target acceptance are not retained'
  ),
  inventory(
    'remoteSiteSettings',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Only concrete RemoteSiteSetting dependencies',
    'Target endpoint approved',
    [],
    'Candidate core metadata transport',
    'No generic remote-site inventory is implied'
  ),
  inventory(
    'reportFolders',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected report folders',
    'Target folder access available',
    [],
    'Candidate core metadata transport',
    'Folder acceptance is not retained'
  ),
  inventory(
    'reports',
    'core-sf',
    'candidate sf project retrieve/deploy',
    'conditional',
    'Selected reports and report types',
    'Folders, source fields, and report types available',
    ['reportFolders'],
    'Candidate core metadata transport',
    'Representative target acceptance is not retained'
  ),
  inventory(
    'senderAddresses',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Required sender addresses and verification state',
    'Approved sender addresses configured in target',
    ['authenticatedSendingDomains'],
    'Sender verification is target-specific and non-portable'
  ),
  inventory(
    'siteReferences',
    'mcnext',
    'MCN planning and target-local mapping',
    'conditional',
    'Site references on selected MCN artifacts',
    'Matching target site provisioned',
    ['landingPageSites'],
    'Inventory requirement only',
    'Portable identity and write behavior are unproven'
  ),
  inventory(
    'subscriptionChannelTypes',
    'mcnext',
    'unproven MCN product-record transport',
    'conditional',
    'Selected subscription channel type definitions',
    'Product enablement and target channel support',
    ['productLicenses'],
    'Inventory requirement only',
    'Exact transport and safe writes are unproven'
  ),
  inventory(
    'targetComponents',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Required target component inventory',
    'Required components installed, enabled, and configured in target',
    ['managedPackages', 'productLicenses'],
    'Component availability is target-specific',
    'No generic component transport is proven'
  ),
  inventory(
    'targetPermissions',
    'external/manual',
    'manual target administration plus conditional core permission-set metadata',
    'manual prerequisite',
    'Required product, object, field, and API permissions',
    'Permission sets deployed where proven and principals granted access',
    ['productLicenses'],
    'User-specific grants require target administration',
    'Permission-set acceptance is not retained; assignments are separate'
  ),
  inventory(
    'userAssignments',
    'external/manual',
    'manual target administration',
    'manual prerequisite',
    'Required user, permission, license, and context assignments',
    'Target users exist and assignments are completed',
    ['productLicenses', 'targetPermissions'],
    'User assignments are target-specific and non-portable'
  ),
  inventory(
    'crmAudienceRows',
    'secondary-data',
    'core sf data where sufficient',
    'deferred',
    'Explicitly selected CRM audience rows',
    'Definitions stable; scale, keys, and relationships reconciled',
    ['customObjectConfiguration'],
    'Optional secondary-data increment',
    'Not configuration-definition migration'
  ),
  inventory(
    'operationalRows',
    'secondary-data',
    'core sf data where sufficient',
    'deferred',
    'Explicitly selected optional operational records',
    'Definitions stable; scale, keys, relationships, and provenance agreed',
    ['customObjectConfiguration'],
    'Optional secondary-data increment'
  ),
  inventory(
    'segmentMembers',
    'secondary-data',
    'MCN REST v67 export only',
    'unsupported',
    'Computed segment members',
    'Definitions migrated and membership recomputed in target',
    ['marketSegmentDefinition'],
    'v0.1.0 supports bounded export',
    'Computed membership is not portable configuration or importable membership'
  ),
];

/** Run bounded, read-only prerequisite checks against source and target orgs. */
export async function runMigrationPreflight(source: Org, target: Org): Promise<PreflightCheck[]> {
  const sourceOrgId = source.getOrgId();
  const targetOrgId = target.getOrgId();
  const sourceApiCheck = await probeApiVersion(source, 'source-api-v67', 'Source');
  const targetApiCheck = await probeApiVersion(target, 'target-api-v67', 'Target');

  return [
    {
      key: 'distinct-orgs',
      status: sourceOrgId === targetOrgId ? 'blocked' : 'pass',
      message:
        sourceOrgId === targetOrgId
          ? 'Source and target resolve to the same org.'
          : 'Source and target are distinct orgs.',
    },
    sourceApiCheck,
    targetApiCheck,
    {
      key: 'target-environment',
      status: 'manual',
      message:
        'Confirm target licenses, products, data spaces, permissions, credentials, domains, DNS, sites, and user assignments.',
    },
  ];
}

/** Build the stable, read-only first-increment migration plan. */
export function buildMigrationPlan(input: {
  sourceOrgId: string;
  targetOrgId: string;
  preflight: PreflightCheck[];
  deferredCmsDependencies?: OpaqueCmsDependency[];
  cmsPlanning?: CmsPlanningState;
}): MigrationPlan {
  return {
    schemaVersion: 1,
    mode: 'read-only',
    testedApiVersion: TESTED_API_VERSION,
    sourceOrgId: input.sourceOrgId,
    targetOrgId: input.targetOrgId,
    executableTargetPayloads: [],
    preflight: [...input.preflight].sort(byKey),
    inventory: [...INVENTORY].sort(byKey),
    deferredCmsDependencies: [...(input.deferredCmsDependencies ?? [])].sort((left, right) =>
      `${left.blockedOperation}\0${left.sourceReference}`.localeCompare(
        `${right.blockedOperation}\0${right.sourceReference}`
      )
    ),
    ...(input.cmsPlanning === undefined ? {} : { cmsPlanning: input.cmsPlanning }),
  };
}

/** Write a deterministic JSON plan, creating parent directories when necessary. */
export async function writeMigrationPlan(plan: MigrationPlan, outputFile: string): Promise<void> {
  await FormatWriter.ensureDir(outputFile);
  await writeFile(outputFile, `${JSON.stringify(plan, undefined, 2)}\n`, 'utf8');
}

function inventory(
  key: string,
  owner: MigrationOwner,
  transport: string,
  status: MigrationStatus,
  sourceSelection: string,
  targetPrerequisite: string,
  dependencies: string[],
  evidence: string,
  limitation?: string
): MigrationInventoryItem {
  return {
    key,
    owner,
    transport,
    classification: owner === 'secondary-data' ? 'secondary-data' : 'configuration',
    status,
    sourceSelection,
    targetPrerequisite,
    dependencies,
    evidence,
    ...(limitation ? { limitation } : {}),
  };
}

async function probeApiVersion(org: Org, key: string, label: string): Promise<PreflightCheck> {
  // The maximum remains optional diagnostic data; only the pinned authenticated request controls status.
  let maximumDiagnostic = 'advertised maximum unavailable';
  try {
    // eslint-disable-next-line sf-plugin/get-connection-with-version -- retrieveMaxApiVersion has no versioned alternative
    const maximum = await org.getConnection().retrieveMaxApiVersion();
    maximumDiagnostic = `advertised maximum v${maximum}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    maximumDiagnostic = `advertised maximum unavailable: ${detail}`;
  }

  try {
    await org.getConnection(TESTED_API_VERSION).request('/limits');
    return {
      key,
      status: 'pass',
      message: `${label} org answered an authenticated, read-only API v${TESTED_API_VERSION} limits request (${maximumDiagnostic}).`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      key,
      status: 'blocked',
      message: `${label} org failed the authenticated, read-only API v${TESTED_API_VERSION} limits request (${maximumDiagnostic}): ${detail}`,
    };
  }
}

function byKey(left: { key: string }, right: { key: string }): number {
  return left.key.localeCompare(right.key);
}
