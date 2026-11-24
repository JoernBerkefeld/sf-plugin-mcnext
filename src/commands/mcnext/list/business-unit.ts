import { Messages, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { readBusinessUnits, type BusinessUnitListing } from '../../../business-units.js';
import type { Status } from '../../../envelope.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.list.business-unit');

export type BusinessUnitListResult = BusinessUnitListing & { status: Status };

export default class ListBusinessUnit extends SfCommand<BusinessUnitListResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
  };

  public async run(): Promise<BusinessUnitListResult> {
    const { flags } = await this.parse(ListBusinessUnit);
    const connection = flags['target-org'].getConnection(flags['api-version']);
    let listing: BusinessUnitListing;
    try {
      listing = await readBusinessUnits(connection);
    } catch (error) {
      throw new SfError(
        messages.getMessage('error.readFailed', [error instanceof Error ? error.message : String(error)]),
        'BUSINESS_UNIT_READ_FAILED'
      );
    }
    this.table({
      data: listing.businessUnits.map((unit) => ({
        developerName: unit.developerName,
        label: unit.label,
        dataSpace: unit.dataSpace ?? '',
        workspaces: unit.workspaces ? unit.workspaces.join(', ') : 'not available',
      })),
      columns: ['developerName', 'label', 'dataSpace', 'workspaces'],
    });
    for (const warning of listing.warnings) this.warn(warning);
    return { status: 0, ...listing };
  }
}
