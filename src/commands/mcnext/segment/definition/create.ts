import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Messages, Org } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { McnClient } from '../../../../client/mcnClient.js';
import {
  createSegmentDefinition,
  resolveBothOrgIdentities,
  type SegmentDefinitionCreateResult,
  type SegmentDescriptor,
} from '../../../../segment/segmentDefinitionCreate.js';
import { runSegmentCore } from '../../../../segment/segmentDefinitionCli.js';
import { type SegmentDefinitionMappingFile } from '../../../../segment/segmentDefinition.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.segment.definition.create');

export const segmentDefinitionCreateServices = {
  createOrg: async (targetOrg: string): Promise<Org> => Org.create({ aliasOrUsername: targetOrg }),
  core: runSegmentCore,
  createConnect: async (
    org: Org,
    apiVersion?: string
  ): Promise<{
    list: () => Promise<SegmentDescriptor[]>;
    show: (apiName: string) => Promise<unknown>;
  }> => {
    const client = await McnClient.create(org, apiVersion);
    return {
      list: async (): Promise<SegmentDescriptor[]> => listSegmentsStrict(client),
      show: async (apiName: string): Promise<unknown> =>
        client.request<unknown>({ path: `/ssot/segments/${encodeURIComponent(apiName)}` }),
    };
  },
};

export async function listSegmentsStrict(client: McnClient): Promise<SegmentDescriptor[]> {
  const segments = await client.requestAll<unknown>(
    {
      path: '/ssot/segments',
      itemsKey: 'segments',
      pageSizeParam: 'batchSize',
      requireItemsKey: true,
      requireCompletePagination: true,
    },
    200,
    { maxPages: 100, maxItems: 20_000, maxDurationMs: 60_000 }
  );
  return segments.map((value) => {
    if (!isRecord(value)) throw new Error('Malformed Connect Segment Definition collection item');
    return value;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Create one unpublished Segment Definition through bounded Core delegation. */
export default class SegmentDefinitionCreate extends SfCommand<SegmentDefinitionCreateResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:segment:definition:create'];
  public static readonly flags = {
    'source-org': Flags.string({ required: true, summary: messages.getMessage('flags.source-org.summary') }),
    'target-org': Flags.string({ required: true, summary: messages.getMessage('flags.target-org.summary') }),
    'expected-source-org-id': Flags.string({
      required: true,
      summary: messages.getMessage('flags.expected-source-org-id.summary'),
    }),
    'expected-target-org-id': Flags.string({
      required: true,
      summary: messages.getMessage('flags.expected-target-org-id.summary'),
    }),
    'project-dir': Flags.directory({
      required: true,
      exists: true,
      summary: messages.getMessage('flags.project-dir.summary'),
    }),
    'source-file': Flags.string({ required: true, summary: messages.getMessage('flags.source-file.summary') }),
    member: Flags.string({ required: true, summary: messages.getMessage('flags.member.summary') }),
    'mapping-file': Flags.string({ required: true, summary: messages.getMessage('flags.mapping-file.summary') }),
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
    'dry-run': Flags.boolean({ summary: messages.getMessage('flags.dry-run.summary') }),
    wait: Flags.integer({ default: 10, min: 1, max: 30, summary: messages.getMessage('flags.wait.summary') }),
    'visibility-polls': Flags.integer({
      default: 3,
      min: 1,
      max: 10,
      summary: messages.getMessage('flags.visibility-polls.summary'),
    }),
  };

  public async run(): Promise<SegmentDefinitionCreateResult> {
    const { flags } = await this.parse(SegmentDefinitionCreate);
    const identitySelection = {
      projectRoot: flags['project-dir'],
      sourceOrg: flags['source-org'],
      targetOrg: flags['target-org'],
      expectedSourceOrgId: flags['expected-source-org-id'],
      expectedTargetOrgId: flags['expected-target-org-id'],
      sourceFile: flags['source-file'],
      member: flags.member,
      mappingFile: {} as SegmentDefinitionMappingFile,
      dryRun: flags['dry-run'],
      waitMinutes: flags.wait,
      visibilityPolls: flags['visibility-polls'],
    };
    let verifiedTargetOrg: Org | undefined;
    await resolveBothOrgIdentities(identitySelection, async (alias) => {
      const org = await segmentDefinitionCreateServices.createOrg(alias);
      if (alias === flags['target-org']) verifiedTargetOrg = org;
      return org.getOrgId();
    });
    if (!verifiedTargetOrg) throw new Error('Authenticated target org could not be resolved');
    const mappingFile = JSON.parse(
      await readFile(resolve(flags['project-dir'], flags['mapping-file']), 'utf8')
    ) as SegmentDefinitionMappingFile;
    const connect = await segmentDefinitionCreateServices.createConnect(verifiedTargetOrg, flags['api-version']);
    const result = await createSegmentDefinition(
      {
        projectRoot: flags['project-dir'],
        sourceOrg: flags['source-org'],
        targetOrg: flags['target-org'],
        expectedSourceOrgId: flags['expected-source-org-id'],
        expectedTargetOrgId: flags['expected-target-org-id'],
        sourceFile: flags['source-file'],
        member: flags.member,
        mappingFile,
        dryRun: flags['dry-run'],
        waitMinutes: flags.wait,
        visibilityPolls: flags['visibility-polls'],
      },
      {
        resolveOrgIdentity: async (alias) => (await segmentDefinitionCreateServices.createOrg(alias)).getOrgId(),
        core: segmentDefinitionCreateServices.core,
        connect,
        initialIdentitiesVerified: true,
      }
    );
    if (result.state === 'pending') process.exitCode = 69;
    this.log(`${result.operation}: ${result.state}; ${result.member}; Core validation ${result.validationJobId}`);
    return result;
  }
}
