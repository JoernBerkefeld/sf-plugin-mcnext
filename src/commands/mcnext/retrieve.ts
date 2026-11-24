import { resolve } from 'node:path';
import { Messages } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import type { Envelope } from '../../envelope.js';
import { retrieve } from '../../orchestrate/retrieve.js';
import { report } from '../../report.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.retrieve');

export default class Retrieve extends SfCommand<Envelope> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
    metadata: Flags.string({ char: 'm', multiple: true, summary: messages.getMessage('flags.metadata.summary') }),
    'output-dir': Flags.directory({ summary: messages.getMessage('flags.output-dir.summary'), default: '.' }),
    'business-unit': Flags.string({ summary: messages.getMessage('flags.business-unit.summary') }),
    workspace: Flags.string({ summary: messages.getMessage('flags.workspace.summary') }),
    dataspace: Flags.string({ summary: messages.getMessage('flags.dataspace.summary') }),
  };

  public async run(): Promise<Envelope> {
    const { flags } = await this.parse(Retrieve);
    const connection = flags['target-org'].getConnection(flags['api-version']);
    const envelope = await retrieve(connection, {
      metadata: flags.metadata,
      outputDir: resolve(flags['output-dir']),
      businessUnit: flags['business-unit'],
      workspace: flags.workspace,
      dataspace: flags.dataspace,
    });
    report(this, envelope);
    return envelope;
  }
}
