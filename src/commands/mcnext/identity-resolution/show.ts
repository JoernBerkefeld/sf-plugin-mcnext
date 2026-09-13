import { Messages, Org } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { McnClient } from '../../../client/mcnClient.js';
import {
  IdentityResolutionConfiguration,
  showIdentityResolution,
} from '../../../identityResolution/identityResolution.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.identity-resolution.show');

export type IdentityResolutionShowResult = IdentityResolutionConfiguration;

export default class IdentityResolutionShow extends SfCommand<IdentityResolutionShowResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:identity-resolution:show'];

  public static readonly flags = {
    'target-org': Flags.string({
      // eslint-disable-next-line sf-plugin/dash-o -- target-org convention intentionally uses -o
      char: 'o',
      required: true,
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'ruleset-id': Flags.string({
      required: true,
      summary: messages.getMessage('flags.ruleset-id.summary'),
    }),
    'api-version': Flags.orgApiVersion({
      summary: messages.getMessage('flags.api-version.summary'),
    }),
  };

  public async run(): Promise<IdentityResolutionShowResult> {
    const { flags } = await this.parse(IdentityResolutionShow);
    const org = await Org.create({ aliasOrUsername: flags['target-org'] });
    const client = await McnClient.create(org, flags['api-version']);
    return showIdentityResolution(client, flags['ruleset-id']);
  }
}
