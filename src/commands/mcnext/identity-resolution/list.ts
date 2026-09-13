import { Messages, Org } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { McnClient } from '../../../client/mcnClient.js';
import {
  IdentityResolutionConfiguration,
  listIdentityResolutions,
} from '../../../identityResolution/identityResolution.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.identity-resolution.list');

export type IdentityResolutionListResult = IdentityResolutionConfiguration[];

export default class IdentityResolutionList extends SfCommand<IdentityResolutionListResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:identity-resolution:list'];

  public static readonly flags = {
    'target-org': Flags.string({
      // eslint-disable-next-line sf-plugin/dash-o -- target-org convention intentionally uses -o
      char: 'o',
      required: true,
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'api-version': Flags.orgApiVersion({
      summary: messages.getMessage('flags.api-version.summary'),
    }),
  };

  public async run(): Promise<IdentityResolutionListResult> {
    const { flags } = await this.parse(IdentityResolutionList);
    const org = await Org.create({ aliasOrUsername: flags['target-org'] });
    const client = await McnClient.create(org, flags['api-version']);
    const result = await listIdentityResolutions(client);

    this.table({
      data: result.map((configuration) => ({
        rulesetId: configuration.rulesetId ?? '',
        label: configuration.label ?? '',
        dataSpaceName: configuration.dataSpaceName ?? '',
        rulesetStatus: configuration.rulesetStatus ?? '',
        lastJobStatus: configuration.lastJobStatus ?? '',
        totalUnifiedProfiles: configuration.totalUnifiedProfiles ?? '',
      })),
      title: 'Identity-resolution configurations',
    });
    return result;
  }
}
