import { Org } from '@salesforce/core';
import { redact } from '../cms/cmsCli.js';
import { retrieveCampaignFlows, type CampaignFlowRetrievalResult } from '../core/campaignFlowRetrieval.js';
import { runCore, type CoreRunner } from '../core/flowCli.js';
import {
  correlateCampaignSegmentDefinitions,
  type CampaignSegmentCorrelationResult,
} from '../segment/segmentMembers.js';
import {
  retrieveAndPublishMarketingCms,
  validateRetrievalProject,
  type MarketingCmsRetrievalServices,
} from './retrieve-resolver.js';
import { retrieveCampaignSnapshots, type CampaignSnapshotsResult } from './retrieveCampaigns.js';
import {
  retrieveIdentityConfiguration,
  type IdentityConfigurationResult,
  type IdentityConfigurationServices,
} from './retrieveData360.js';

export type RetrieveAllInput = {
  projectRoot: string;
  targetOrg: string;
  expectedOrgId: string;
  apiVersion: string;
  waitMinutes?: number;
};
export type RetrieveAllState = 'success' | 'partial' | 'blocked' | 'failed' | 'pending';
type CmsResult = Awaited<ReturnType<typeof retrieveAndPublishMarketingCms>>;
export type RetrieveAllProvider = {
  provider: 'mcnext' | 'core-sf' | 'sf-plugin-cms' | 'data360';
  family: string;
  state: RetrieveAllState;
  files: string[];
  diagnostics: string[];
  result?:
    | CampaignSnapshotsResult
    | CampaignFlowRetrievalResult
    | CampaignSegmentCorrelationResult
    | IdentityConfigurationResult
    | CmsResult;
  stagingDirectory?: string;
  retainedRoot?: string;
  jobId?: string;
};
export type RetrieveAllResult = {
  state: RetrieveAllState;
  complete: false;
  files: string[];
  diagnostics: string[];
  providers: RetrieveAllProvider[];
};
export type RetrieveAllServices = IdentityConfigurationServices & {
  core?: CoreRunner;
  cms?: MarketingCmsRetrievalServices;
  campaigns?: typeof retrieveCampaignSnapshots;
  flows?: typeof retrieveCampaignFlows;
  segments?: typeof correlateCampaignSegmentDefinitions;
  identity?: typeof retrieveIdentityConfiguration;
  marketingCms?: typeof retrieveAndPublishMarketingCms;
};

export type RetrieveAllPublicEvidence = {
  campaigns?: Array<{ campaignId: string; state: RetrieveAllState; files: string[]; diagnostics: string[] }>;
  members?: string[];
  associationPersistence?: 'blocked';
  correlation?: CampaignSegmentCorrelationResult;
  rulesetIds?: string[];
  cms?: {
    retrievalState: CmsResult['retrieval']['state'];
    publication: CmsResult['publication']['publication'];
    workspaces: Array<
      CmsResult['publication']['workspaces'][number] & { diagnostics: string[]; manifestSha256?: string }
    >;
    externalReferenceCorrelations: Array<{
      sourceWorkspaceId: string;
      sourceReference: string;
      referenceKind: 'cms.content';
      referenceId: string;
      packageManifestSha256: string;
    }>;
  };
};
export type RetrieveAllPublicProvider = Omit<RetrieveAllProvider, 'result'> & {
  evidence?: RetrieveAllPublicEvidence;
};
export type RetrieveAllPublicResult = Omit<RetrieveAllResult, 'providers'> & {
  providers: RetrieveAllPublicProvider[];
};

/** Explicit public allowlist; original typed evidence and opaque ownership remain internal. */
export function projectRetrieveAllResult(result: RetrieveAllResult): RetrieveAllPublicResult {
  return {
    state: result.state,
    complete: false,
    files: [...result.files],
    diagnostics: result.diagnostics.map(redact),
    providers: result.providers.map((row) => ({
      provider: row.provider,
      family: row.family,
      state: row.state,
      files: [...row.files],
      diagnostics: row.diagnostics.map(redact),
      ...(row.stagingDirectory ? { stagingDirectory: row.stagingDirectory } : {}),
      ...(row.retainedRoot ? { retainedRoot: row.retainedRoot } : {}),
      ...(row.jobId ? { jobId: row.jobId } : {}),
      ...(row.result ? { evidence: publicEvidence(row.result) } : {}),
    })),
  };
}

function publicEvidence(result: NonNullable<RetrieveAllProvider['result']>): RetrieveAllPublicEvidence {
  if ('retrieval' in result) {
    const exported = result.retrieval.exportEnvelope?.result;
    return {
      cms: {
        retrievalState: result.retrieval.state,
        publication: result.publication.publication,
        workspaces: result.publication.workspaces.map((row) => {
          const source = exported?.workspaces.find((entry) => entry.source.sourceId === row.sourceWorkspaceId);
          return {
            sourceWorkspaceId: row.sourceWorkspaceId,
            sourceStatus: row.sourceStatus,
            publication: row.publication,
            files: [...row.files],
            diagnostics: [...(source?.diagnostics.warnings ?? []), ...(source?.diagnostics.errors ?? [])].map(
              (entry) => `${entry.code}: ${redact(entry.message)}`
            ),
            ...(source?.artifact ? { manifestSha256: source.artifact.manifestSha256 } : {}),
          };
        }),
        externalReferenceCorrelations: (exported?.externalReferenceCorrelations ?? []).map((entry) => ({
          sourceWorkspaceId: entry.sourceWorkspaceId,
          sourceReference: entry.sourceReference,
          referenceKind: entry.referenceKind,
          referenceId: entry.referenceId,
          packageManifestSha256: entry.packageManifestSha256,
        })),
      },
    };
  }
  if ('campaigns' in result)
    return {
      campaigns: result.campaigns.map((row) => ({
        campaignId: row.campaignId,
        state: row.state,
        files: [...row.files],
        diagnostics: row.diagnostics.map(redact),
      })),
    };
  if ('members' in result)
    return { members: [...result.members], associationPersistence: result.associationPersistence };
  if ('flows' in result)
    return {
      correlation: {
        campaignId: result.campaignId,
        orgId: result.orgId,
        apiVersion: result.apiVersion,
        dataSpace: result.dataSpace,
        state: result.state,
        associationPersistence: result.associationPersistence,
        diagnostics: result.diagnostics.map(redact),
        flows: result.flows.map((row) => ({
          flowRecordId: row.flowRecordId,
          flowApiName: row.flowApiName,
          state: row.state,
          ...(row.segmentId ? { segmentId: row.segmentId } : {}),
          ...(row.segmentApiName ? { segmentApiName: row.segmentApiName } : {}),
          ...(row.segmentDefinitionId ? { segmentDefinitionId: row.segmentDefinitionId } : {}),
          ...(row.nativeMember ? { nativeMember: row.nativeMember } : {}),
          diagnostics: row.diagnostics.map(redact),
        })),
      },
    };
  return {
    rulesetIds: (result.result?.identityResolutions ?? []).flatMap((row) => (row.rulesetId ? [row.rulesetId] : [])),
  };
}

/** Compose real bounded downloads; native backup and attachment fidelity remain unqualified. */
// eslint-disable-next-line complexity -- one bounded coordinator preserves independent provider outcomes and publication order
export async function retrieveAll(
  input: RetrieveAllInput,
  services: RetrieveAllServices = {}
): Promise<RetrieveAllResult> {
  const outcome: RetrieveAllResult = {
    state: 'blocked',
    complete: false,
    files: [],
    providers: [],
    diagnostics: ['Best-available working retrieval only; this is not a complete native backup or restore kit.'],
  };
  try {
    await validateRetrievalProject(input.projectRoot);
    if (
      input.apiVersion !== '67.0' ||
      !/^00D[A-Za-z0-9]{15}$/u.test(input.expectedOrgId) ||
      !input.targetOrg.trim() ||
      input.targetOrg.startsWith('-') ||
      input.targetOrg.includes('\0') ||
      !Number.isInteger(input.waitMinutes ?? 10) ||
      (input.waitMinutes ?? 10) < 1 ||
      (input.waitMinutes ?? 10) > 30
    ) {
      throw new Error('Explicit selected org, API 67.0 and wait 1–30 are required');
    }
    const org = await (services.createOrg ?? ((targetOrg): Promise<Org> => Org.create({ aliasOrUsername: targetOrg })))(
      input.targetOrg
    );
    if (org.getOrgId() !== input.expectedOrgId) throw new Error('Fresh selected org identity mismatch');
  } catch (error) {
    outcome.diagnostics.push(`Aggregate preflight: ${safeError(error)}`);
    return outcome;
  }
  const core = services.core ?? runCore;
  const selectedMembers = new Set<string>();
  const snapshots = await attempt(outcome, 'mcnext', 'campaign-snapshots', async () => {
    const result = await (services.campaigns ?? retrieveCampaignSnapshots)(input, core);
    return { result, state: result.state, files: result.files, diagnostics: result.diagnostics };
  });
  // Only fresh read evidence selects downstream work; a publication collision does not discard it.
  const campaigns = snapshots?.result && 'campaigns' in snapshots.result ? snapshots.result.campaigns : [];
  if (campaigns.length) {
    for (const campaign of campaigns) {
      if (!campaign.result || campaign.result.operation !== 'export') {
        blocked(outcome, 'core-sf', `campaign-flows:${campaign.campaignId}`, 'Fresh Campaign evidence unavailable');
        blocked(outcome, 'mcnext', `segment-correlation:${campaign.campaignId}`, 'Fresh Campaign evidence unavailable');
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- one writer preserves deterministic native publication
      await attempt(outcome, 'core-sf', `campaign-flows:${campaign.campaignId}`, async () => {
        const guardedCore: CoreRunner = async (args, cwd) => {
          if (args[0] === 'project' && args[1] === 'retrieve' && args[2] === 'start') {
            const members = args.flatMap((arg, index) => (arg === '--metadata' ? [args[index + 1]] : []));
            if (members.some((member) => selectedMembers.has(member))) {
              throw new Error(
                'Conflicting duplicate native Flow member across Campaigns; dependent publication blocked'
              );
            }
            for (const member of members) selectedMembers.add(member);
          }
          return core(args, cwd);
        };
        const result = await (services.flows ?? retrieveCampaignFlows)(
          { ...input, campaignId: campaign.campaignId },
          guardedCore
        );
        return {
          result,
          state:
            result.state === 'succeeded'
              ? 'success'
              : result.diagnostics.some((entry) => entry.includes('Conflicting duplicate native Flow member')) &&
                !result.files.length
              ? 'blocked'
              : result.state,
          files: result.files.map((file) => file.filePath),
          diagnostics: result.diagnostics,
          ...(result.stagingProject ? { stagingDirectory: result.stagingProject } : {}),
          ...(result.retainedRoot ? { retainedRoot: result.retainedRoot } : {}),
          ...(result.jobId ? { jobId: result.jobId } : {}),
        };
      });
      // eslint-disable-next-line no-await-in-loop -- correlation rediscovery is independent of native publication
      await attempt(outcome, 'mcnext', `segment-correlation:${campaign.campaignId}`, async () => {
        const result = await (services.segments ?? correlateCampaignSegmentDefinitions)(
          { ...input, campaignId: campaign.campaignId },
          { core, createOrg: services.createOrg, createClient: services.createClient }
        );
        return {
          result,
          state: result.state === 'complete' ? 'success' : 'blocked',
          files: [],
          diagnostics: result.diagnostics,
        };
      });
    }
  } else if (!snapshots || snapshots.state !== 'success') {
    blocked(outcome, 'core-sf', 'campaign-flows', 'Complete bounded Campaign enumeration unavailable');
    blocked(outcome, 'mcnext', 'segment-correlation', 'Complete bounded Campaign enumeration unavailable');
  }
  await attempt(outcome, 'sf-plugin-cms', 'marketing-workspaces', async () => {
    const result = await (services.marketingCms ?? retrieveAndPublishMarketingCms)(input, {
      ...services.cms,
      createOrg: services.cms?.createOrg ?? services.createOrg,
    });
    const publication = result.publication;
    return {
      result,
      state: publication.state,
      files: publication.files,
      diagnostics: [...result.retrieval.diagnostics, ...publication.diagnostics].map(
        (entry) => `${entry.code}: ${entry.message}`
      ),
      ...(publication.stagingDirectory ? { stagingDirectory: publication.stagingDirectory } : {}),
      ...(!publication.stagingDirectory && publication.stagingOwner
        ? { retainedRoot: publication.stagingOwner.root }
        : {}),
    };
  });
  await attempt(outcome, 'data360', 'identity-configuration', async () => {
    const result = await (services.identity ?? retrieveIdentityConfiguration)(input, {
      createOrg: services.createOrg,
      createClient: services.createClient,
    });
    return { result, state: result.state, files: result.files, diagnostics: result.diagnostics };
  });
  blocked(
    outcome,
    'core-sf',
    'native-segments',
    'Authoritative complete native Segment selection and unique member identity remain unqualified; correlation is not a native backup.'
  );
  blocked(
    outcome,
    'mcnext',
    'campaign-association-persistence',
    'Native Flow XML does not persist Campaign/FlowRecord attachment; no qualified association artifact contract.'
  );
  blocked(
    outcome,
    'data360',
    'native-identity-configuration',
    'Downloaded rulesetId configuration collection does not qualify native Data360 prerequisites, all data spaces or restore fidelity.'
  );
  blocked(
    outcome,
    'data360',
    'native-data-graphs',
    'No selected-org complete native graph definition exporter or qualified vendor contract.'
  );
  outcome.files = [...new Set(outcome.providers.flatMap((provider) => provider.files))];
  outcome.state = reduceState(outcome.providers);
  return outcome;
}

async function attempt(
  outcome: RetrieveAllResult,
  provider: RetrieveAllProvider['provider'],
  family: string,
  run: () => Promise<Omit<RetrieveAllProvider, 'provider' | 'family'>>
): Promise<RetrieveAllProvider | undefined> {
  try {
    const row = { provider, family, ...(await run()) };
    outcome.providers.push(row);
    return row;
  } catch (error) {
    outcome.providers.push({ provider, family, state: 'failed', files: [], diagnostics: [safeError(error)] });
    return undefined;
  }
}
function blocked(
  outcome: RetrieveAllResult,
  provider: RetrieveAllProvider['provider'],
  family: string,
  reason: string
): void {
  outcome.providers.push({ provider, family, state: 'blocked', files: [], diagnostics: [reason] });
}
function reduceState(providers: RetrieveAllProvider[]): RetrieveAllState {
  const productive = providers.some(
    (provider) => provider.files.length || provider.state === 'success' || provider.state === 'partial'
  );
  const terminal = providers.some((provider) => provider.state === 'failed' || provider.state === 'blocked');
  if (terminal)
    return productive ? 'partial' : providers.some((provider) => provider.state === 'failed') ? 'failed' : 'blocked';
  if (providers.some((provider) => provider.state === 'pending')) return 'pending';
  return providers.some((provider) => provider.state === 'partial') ? 'partial' : 'success';
}
function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
