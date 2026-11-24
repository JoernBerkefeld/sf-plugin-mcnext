import { Messages } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import type { Envelope } from '../../envelope.js';
import { remove } from '../../orchestrate/remove.js';
import { report } from '../../report.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.delete');

export default class Delete extends SfCommand<Envelope> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
    metadata: Flags.string({ char: 'm', multiple: true, summary: messages.getMessage('flags.metadata.summary') }),
    'source-dir': Flags.string({ char: 'd', multiple: true, summary: messages.getMessage('flags.source-dir.summary') }),
    preview: Flags.boolean({ summary: messages.getMessage('flags.preview.summary') }),
    workspace: Flags.string({ summary: messages.getMessage('flags.workspace.summary') }),
    'confirm-delete': Flags.boolean({ summary: messages.getMessage('flags.confirm-delete.summary') }),
    'keep-local-files': Flags.boolean({ summary: messages.getMessage('flags.keep-local-files.summary') }),
  };

  public async run(): Promise<Envelope> {
    const { flags } = await this.parse(Delete);
    const connection = flags['target-org'].getConnection(flags['api-version']);
    const envelope = await remove(connection, {
      metadata: flags.metadata,
      sourceDirs: flags['source-dir'],
      projectDir: process.cwd(),
      preview: flags.preview,
      confirmDelete: flags['confirm-delete'],
      workspace: flags.workspace,
      keepLocalFiles: flags['keep-local-files'],
    });
    report(this, envelope);
    return envelope;
  }
}
