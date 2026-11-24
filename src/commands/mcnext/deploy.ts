import { Messages } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import type { Envelope } from '../../envelope.js';
import { deploy } from '../../orchestrate/deploy.js';
import { report } from '../../report.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.deploy');

export default class Deploy extends SfCommand<Envelope> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
    metadata: Flags.string({ char: 'm', multiple: true, summary: messages.getMessage('flags.metadata.summary') }),
    'source-dir': Flags.string({ char: 'd', multiple: true, summary: messages.getMessage('flags.source-dir.summary') }),
    preview: Flags.boolean({ summary: messages.getMessage('flags.preview.summary') }),
    'business-unit': Flags.string({ summary: messages.getMessage('flags.business-unit.summary') }),
    workspace: Flags.string({ summary: messages.getMessage('flags.workspace.summary') }),
    dataspace: Flags.string({ summary: messages.getMessage('flags.dataspace.summary') }),
    'allow-cross-dataspace': Flags.boolean({ summary: messages.getMessage('flags.allow-cross-dataspace.summary') }),
    'allow-activation': Flags.boolean({ summary: messages.getMessage('flags.allow-activation.summary') }),
  };

  public async run(): Promise<Envelope> {
    const { flags } = await this.parse(Deploy);
    const connection = flags['target-org'].getConnection(flags['api-version']);
    const envelope = await deploy(connection, {
      metadata: flags.metadata,
      sourceDirs: flags['source-dir'],
      projectDir: process.cwd(),
      preview: flags.preview,
      businessUnit: flags['business-unit'],
      workspace: flags.workspace,
      dataspace: flags.dataspace,
      allowCrossDataspace: flags['allow-cross-dataspace'],
      allowActivation: flags['allow-activation'],
    });
    report(this, envelope);
    return envelope;
  }
}
