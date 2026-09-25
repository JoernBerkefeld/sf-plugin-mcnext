import { readFile } from 'node:fs/promises';
import { Messages, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.data-graph.metadata');

export type DataGraphMetadataResult = Record<string, unknown>;

export default class DataGraphMetadata extends SfCommand<DataGraphMetadataResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:data-graph:metadata'];

  public static readonly flags = {
    'instance-url': Flags.url({ required: true, summary: messages.getMessage('flags.instance-url.summary') }),
    'access-token-file': Flags.file({
      exists: true,
      required: true,
      summary: messages.getMessage('flags.access-token-file.summary'),
    }),
  };

  public async run(): Promise<DataGraphMetadataResult> {
    const { flags } = await this.parse(DataGraphMetadata);
    const token = (await readFile(flags['access-token-file'], 'utf8')).trim();
    if (!token || /\s/u.test(token))
      throw new SfError('Access token file must contain one token.', 'InvalidAccessToken');

    const url = new URL('/api/v1/dataGraph/metadata', flags['instance-url']);
    if (url.protocol !== 'https:')
      throw new SfError('Data 360 instance URL must use HTTPS.', 'InvalidData360InstanceUrl');

    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw new SfError(`Data Graph metadata request failed with HTTP ${response.status}.`, 'DataGraphMetadataError');
    }

    const result: unknown = await response.json();
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new SfError('Data Graph metadata response must be an object.', 'InvalidDataGraphMetadataResponse');
    }

    return result as DataGraphMetadataResult;
  }
}
