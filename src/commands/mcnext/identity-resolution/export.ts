import { Messages, Org } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { McnClient } from '../../../client/mcnClient.js';
import { exportIdentityResolutionConfiguration } from '../../../identityResolution/identityResolution.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.identity-resolution.export');

export type IdentityResolutionExportResult = {
  rulesetId: string;
  outputFile: string;
  configuration: true;
};

export default class IdentityResolutionExport extends SfCommand<IdentityResolutionExportResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:identity-resolution:export'];

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
    'output-file': Flags.string({
      required: true,
      summary: messages.getMessage('flags.output-file.summary'),
    }),
    'api-version': Flags.orgApiVersion({
      summary: messages.getMessage('flags.api-version.summary'),
    }),
  };

  public async run(): Promise<IdentityResolutionExportResult> {
    const { flags } = await this.parse(IdentityResolutionExport);
    const org = await Org.create({ aliasOrUsername: flags['target-org'] });
    const client = await McnClient.create(org, flags['api-version']);
    await exportIdentityResolutionConfiguration(client, flags['ruleset-id'], flags['output-file']);

    return {
      rulesetId: flags['ruleset-id'],
      outputFile: flags['output-file'],
      configuration: true,
    };
  }
}
