import { Messages, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { getType } from '../../../../registry/registry.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.email.send-definition.show');

export type SendDefinitionShowResult = { delegatedCommand: string; result: unknown };

export default class SendDefinitionShow extends SfCommand<SendDefinitionShowResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:email:send-definition:show'];

  public static readonly flags = {
    'target-org': Flags.string({
      // eslint-disable-next-line sf-plugin/dash-o -- target-org convention intentionally uses -o
      char: 'o',
      required: true,
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'record-id': Flags.string({ required: true, summary: messages.getMessage('flags.record-id.summary') }),
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
  };

  public async run(): Promise<SendDefinitionShowResult> {
    const { flags } = await this.parse(SendDefinitionShow);
    const sObject = getType('listEmail')?.delegation?.sObject;
    if (!sObject) throw new SfError('ListEmail core CLI delegation is not configured.', 'MissingListEmailDelegation');

    const args = ['--sobject', sObject, '--record-id', flags['record-id'], '--target-org', flags['target-org']];
    if (flags['api-version']) args.push('--api-version', flags['api-version']);
    const delegatedCommand = `sf data get record ${args.join(' ')}`;
    this.log(`Delegating to core Salesforce CLI: ${delegatedCommand}`);
    const result = await this.config.runCommand('data get record', args);
    return { delegatedCommand, result };
  }
}
