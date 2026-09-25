import { resolve } from 'node:path';
import { Messages, Org } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { McnClient } from '../../../client/mcnClient.js';
import {
  buildIdentityResolutionPlan,
  readIdentityResolutionPlanInput,
  type IdentityResolutionPlan,
  type IdentityResolutionPlanSelection,
} from '../../../identityResolution/identityResolutionPlan.js';
import { resolveExpectedOrgIdentity } from '../../../mutation/orgIdentity.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.identity-resolution.plan');

export const identityResolutionPlanServices = {
  resolveExpectedOrgIdentity,
  readInput: readIdentityResolutionPlanInput,
  createOrg: async (targetOrg: string): Promise<Org> => Org.create({ aliasOrUsername: targetOrg }),
  createClient: async (org: Org, apiVersion?: string): Promise<McnClient> => McnClient.create(org, apiVersion),
};

export type IdentityResolutionPlanResult = IdentityResolutionPlan;

/** Produce a GET-only identity-resolution CREATE or UPDATE-shell plan. */
export default class IdentityResolutionPlanCommand extends SfCommand<IdentityResolutionPlanResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:identity-resolution:plan'];
  public static readonly flags = {
    intent: Flags.option({
      options: ['create', 'update-shell'] as const,
      required: true,
      summary: messages.getMessage('flags.intent.summary'),
    })(),
    'source-org': Flags.string({
      required: true,
      summary: messages.getMessage('flags.source-org.summary'),
    }),
    'target-org': Flags.string({
      // eslint-disable-next-line sf-plugin/dash-o -- target-org convention intentionally uses -o
      char: 'o',
      required: true,
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'expected-source-org-id': Flags.string({
      required: true,
      summary: messages.getMessage('flags.expected-source-org-id.summary'),
    }),
    'expected-target-org-id': Flags.string({
      required: true,
      summary: messages.getMessage('flags.expected-target-org-id.summary'),
    }),
    'target-ruleset-id': Flags.string({ summary: messages.getMessage('flags.target-ruleset-id.summary') }),
    'expected-target-label': Flags.string({ summary: messages.getMessage('flags.expected-target-label.summary') }),
    'expected-target-key': Flags.string({ summary: messages.getMessage('flags.expected-target-key.summary') }),
    'expected-target-status': Flags.string({ summary: messages.getMessage('flags.expected-target-status.summary') }),
    'input-file': Flags.string({
      required: true,
      summary: messages.getMessage('flags.input-file.summary'),
    }),
    'api-version': Flags.orgApiVersion({
      summary: messages.getMessage('flags.api-version.summary'),
    }),
  };

  public async run(): Promise<IdentityResolutionPlanResult> {
    const { flags } = await this.parse(IdentityResolutionPlanCommand);
    const targetFlags = [
      flags['target-ruleset-id'],
      flags['expected-target-label'],
      flags['expected-target-key'],
      flags['expected-target-status'],
    ];
    if (flags.intent === 'create' && targetFlags.some((value) => value !== undefined))
      throw new Error('CREATE intent does not accept UPDATE target expectations');
    if (flags.intent === 'update-shell' && targetFlags.some((value) => value === undefined))
      throw new Error('UPDATE-shell intent requires exact ruleset ID, label, key and status');
    const sourceIdentity = await identityResolutionPlanServices.resolveExpectedOrgIdentity({
      targetOrg: flags['source-org'],
      expectedOrgId: flags['expected-source-org-id'],
      role: 'source',
    });
    const targetIdentity = await identityResolutionPlanServices.resolveExpectedOrgIdentity({
      targetOrg: flags['target-org'],
      expectedOrgId: flags['expected-target-org-id'],
      role: 'target',
    });
    if (sourceIdentity.orgId === targetIdentity.orgId) {
      throw new Error('Source and target org IDs must be different');
    }
    const input = await identityResolutionPlanServices.readInput(resolve(flags['input-file']));
    const selection: IdentityResolutionPlanSelection =
      flags.intent === 'create'
        ? { intent: flags.intent }
        : {
            intent: flags.intent,
            expectedTarget: {
              rulesetId: flags['target-ruleset-id']!,
              label: flags['expected-target-label']!,
              key: flags['expected-target-key']!,
              status: flags['expected-target-status']!,
            },
          };
    const org = await identityResolutionPlanServices.createOrg(flags['target-org']);
    const client = await identityResolutionPlanServices.createClient(org, flags['api-version']);
    const result = await buildIdentityResolutionPlan(client, input, selection);
    this.log(messages.getMessage('info.result', [result.intent, result.differences.length]));
    return result;
  }
}
