import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { getTypes } from '../../../registry/registry.js';
import { Coverage } from '../../../registry/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.list.types');

export type ListTypesResult = Array<{
  name: string;
  coverage: Coverage;
  description: string;
  delegatedTo: string;
}>;

export default class ListTypes extends SfCommand<ListTypesResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:list:types'];

  public static readonly flags = {
    coverage: Flags.option({
      summary: messages.getMessage('flags.coverage.summary'),
      options: ['gap', 'core-sf'] as const,
    })(),
  };

  public async run(): Promise<ListTypesResult> {
    const { flags } = await this.parse(ListTypes);
    const result: ListTypesResult = getTypes(flags.coverage).map((type) => ({
      name: type.name,
      coverage: type.coverage,
      description: type.description,
      delegatedTo: describeDelegation(type.delegation),
    }));

    this.table({
      data: result,
      title: 'Marketing Cloud Next types',
    });

    return result;
  }
}

/**
 * Render the core command a delegated type is handled by.
 *
 * @param [delegation] - delegation details for a `core-sf` type
 * @returns the command a user would run by hand, or a dash for gap types
 */
function describeDelegation(delegation?: { metadataType?: string; sObject?: string }): string {
  if (delegation?.metadataType) {
    return `sf project retrieve start -m ${delegation.metadataType}`;
  }
  if (delegation?.sObject) {
    return `sf data export bulk (${delegation.sObject})`;
  }
  return '- (this plugin)';
}
