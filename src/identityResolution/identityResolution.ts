import { writeFile } from 'node:fs/promises';
import { McnClient } from '../client/mcnClient.js';
import { FormatWriter } from '../format/formatWriter.js';

const IDENTITY_RESOLUTIONS_PATH = '/ssot/identity-resolutions';

/** Identity-resolution ruleset configuration returned by the verified v67 endpoint. */
export type IdentityResolutionConfiguration = Record<string, unknown> & {
  id?: string;
  rulesetId?: string;
  label?: string;
  dataSpaceName?: string;
  objectApiName?: string;
  secondaryDmo?: string;
  filters?: unknown[];
  matchRules?: unknown[];
  reconciliationRules?: unknown[];
  rulesetStatus?: string;
  lastJobStatus?: string;
  lastJobCompleted?: string;
  doesRunAutomatically?: boolean;
  anonymousUnifiedProfiles?: number;
  knownUnifiedProfiles?: number;
  matchedSourceProfiles?: number;
  sourceProfiles?: number;
  totalUnifiedProfiles?: number;
  consolidationRate?: number;
};

/** Fetch all ruleset configurations from the non-paginated v67 collection envelope. */
export async function listIdentityResolutions(client: McnClient): Promise<IdentityResolutionConfiguration[]> {
  const response = await client.request<{ identityResolutions?: IdentityResolutionConfiguration[] }>({
    path: IDENTITY_RESOLUTIONS_PATH,
  });
  return Array.isArray(response.identityResolutions) ? response.identityResolutions : [];
}

/** Fetch one bare ruleset configuration by Salesforce ruleset ID. */
export async function showIdentityResolution(
  client: McnClient,
  rulesetId: string
): Promise<IdentityResolutionConfiguration> {
  return client.request<IdentityResolutionConfiguration>({
    path: `${IDENTITY_RESOLUTIONS_PATH}/${encodeURIComponent(rulesetId)}`,
  });
}

/** Write the complete ruleset configuration; this does not export unified-profile rows. */
export async function exportIdentityResolutionConfiguration(
  client: McnClient,
  rulesetId: string,
  outputFile: string
): Promise<IdentityResolutionConfiguration> {
  const configuration = await showIdentityResolution(client, rulesetId);
  await FormatWriter.ensureDir(outputFile);
  await writeFile(outputFile, `${JSON.stringify(configuration, undefined, 2)}\n`, 'utf8');
  return configuration;
}
