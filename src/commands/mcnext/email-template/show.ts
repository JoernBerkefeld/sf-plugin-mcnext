import { Messages, Org } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { McnClient } from '../../../client/mcnClient.js';
import { type EmailTemplate, showEmailTemplate } from '../../../email/emailTemplate.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.email-template.show');

export default class EmailTemplateShow extends SfCommand<EmailTemplate> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:email-template:show'];

  public static readonly flags = {
    'target-org': Flags.string({
      // eslint-disable-next-line sf-plugin/dash-o -- target-org convention intentionally uses -o
      char: 'o',
      required: true,
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'content-id': Flags.string({ required: true, summary: messages.getMessage('flags.content-id.summary') }),
    'api-version': Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') }),
  };

  public async run(): Promise<EmailTemplate> {
    const { flags } = await this.parse(EmailTemplateShow);
    const org = await Org.create({ aliasOrUsername: flags['target-org'] });
    const client = await McnClient.create(org, flags['api-version']);
    return showEmailTemplate(client, flags['content-id']);
  }
}
