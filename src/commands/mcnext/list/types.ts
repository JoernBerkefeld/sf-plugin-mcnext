import { Messages } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { getTypes } from '../../../registry/registry.js';
import { McnOperation, Provider, SupportState } from '../../../registry/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.list.types');

export type ListTypesResult = Array<{
  name: string;
  provider: Provider;
  state: SupportState;
  operations: McnOperation[];
  description: string;
  delegatedTo: string;
  limitation: string;
}>;

export default class ListTypes extends SfCommand<ListTypesResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:list:types'];

  public static readonly flags = {
    provider: Flags.option({
      summary: messages.getMessage('flags.provider.summary'),
      options: ['mcnext', 'core-sf', 'cms-v2'] as const,
    })(),
    state: Flags.option({
      summary: messages.getMessage('flags.state.summary'),
      options: ['implemented', 'delegated', 'conditional', 'deferred'] as const,
    })(),
  };

  public async run(): Promise<ListTypesResult> {
    const { flags } = await this.parse(ListTypes);
    const result: ListTypesResult = getTypes(flags).map((type) => ({
      name: type.name,
      provider: type.provider,
      state: type.state,
      operations: type.operations,
      description: type.description,
      delegatedTo: describeDelegation(type.delegation),
      limitation: type.limitation ?? '',
    }));

    this.table({ data: result, title: 'Marketing Cloud Next capabilities' });
    return result;
  }
}

/** Render the core command family for a delegated capability. */
function describeDelegation(delegation?: { metadataType?: string; sObject?: string }): string {
  if (delegation?.metadataType) {
    return `sf project retrieve start -m ${delegation.metadataType}`;
  }
  if (delegation?.sObject) {
    return `sf data export bulk (${delegation.sObject})`;
  }
  return '';
}
