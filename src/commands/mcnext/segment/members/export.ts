import { Messages, Org, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { McnClient, PaginationLimits } from '../../../../client/mcnClient.js';
import { writeAtomicOutput } from '../../../../filesystem/atomicOutput.js';
import {
  querySegmentMemberDetails,
  SegmentMemberDetailColumn,
  SegmentMemberDetailSource,
} from '../../../../segment/segmentMemberDetails.js';
import {
  createSegmentMembersRequest,
  resolveSegment,
  SegmentDescriptor,
  SegmentMember,
} from '../../../../segment/segmentMembers.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.segment.members.export');

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_DATA_SPACE = 'default';

export type SegmentMembersExportResult = {
  segmentApiName: string;
  outputFile: string;
  resultFormat: 'csv' | 'json';
  includeDetails: boolean;
  dataSpace: string;
  rowsWritten: number;
  complete: true;
  enriched?: {
    objectApiName: string;
    columns: SegmentMemberDetailColumn[];
  };
};

type ExportOptions = {
  client: McnClient;
  segment: string;
  outputFile: string;
  resultFormat: 'csv' | 'json';
  includeDetails?: boolean;
  dataSpace?: string;
  fields?: string;
  filters?: string;
  orderBy?: string;
  limit: number;
  offset?: number;
  columnDelimiter?: 'BACKQUOTE' | 'CARET' | 'COMMA' | 'PIPE' | 'SEMICOLON' | 'TAB';
  lineEnding?: 'LF' | 'CRLF';
  paginationLimits: PaginationLimits;
};

export default class SegmentMembersExport extends SfCommand<SegmentMembersExportResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:segment:members:export'];

  public static readonly flags = {
    'target-org': Flags.string({
      // eslint-disable-next-line sf-plugin/dash-o -- target-org convention intentionally uses -o
      char: 'o',
      required: true,
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    segment: Flags.string({
      char: 's',
      required: true,
      summary: messages.getMessage('flags.segment.summary'),
    }),
    'output-file': Flags.string({
      required: true,
      summary: messages.getMessage('flags.output-file.summary'),
    }),
    'result-format': Flags.option({
      options: ['csv', 'json'] as const,
      default: 'csv',
      summary: messages.getMessage('flags.result-format.summary'),
    })(),
    'include-details': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.include-details.summary'),
    }),
    'data-space': Flags.string({
      default: DEFAULT_DATA_SPACE,
      summary: messages.getMessage('flags.data-space.summary'),
    }),
    fields: Flags.string({
      summary: messages.getMessage('flags.fields.summary'),
    }),
    filters: Flags.string({
      summary: messages.getMessage('flags.filters.summary'),
    }),
    'order-by': Flags.string({
      summary: messages.getMessage('flags.order-by.summary'),
    }),
    limit: Flags.integer({
      default: DEFAULT_PAGE_SIZE,
      min: 1,
      summary: messages.getMessage('flags.limit.summary'),
    }),
    offset: Flags.integer({
      default: 0,
      min: 0,
      summary: messages.getMessage('flags.offset.summary'),
    }),
    // eslint-disable-next-line sf-plugin/flag-min-max-default -- optional override must not replace the client default
    'max-pages': Flags.integer({
      min: 1,
      summary: messages.getMessage('flags.max-pages.summary'),
    }),
    // eslint-disable-next-line sf-plugin/flag-min-max-default -- optional override must not replace the client default
    'max-items': Flags.integer({
      min: 1,
      summary: messages.getMessage('flags.max-items.summary'),
    }),
    // eslint-disable-next-line sf-plugin/flag-min-max-default -- optional override must not replace the client default
    'max-duration-ms': Flags.integer({
      min: 1,
      summary: messages.getMessage('flags.max-duration-ms.summary'),
    }),
    'column-delimiter': Flags.option({
      options: ['BACKQUOTE', 'CARET', 'COMMA', 'PIPE', 'SEMICOLON', 'TAB'] as const,
      summary: messages.getMessage('flags.column-delimiter.summary'),
    })(),
    'line-ending': Flags.option({
      options: ['LF', 'CRLF'] as const,
      summary: messages.getMessage('flags.line-ending.summary'),
    })(),
    'api-version': Flags.orgApiVersion({
      summary: messages.getMessage('flags.api-version.summary'),
    }),
  };

  public async run(): Promise<SegmentMembersExportResult> {
    const { flags } = await this.parse(SegmentMembersExport);
    const org = await Org.create({ aliasOrUsername: flags['target-org'] });
    const client = await McnClient.create(org, flags['api-version']);

    return exportSegmentMembers({
      client,
      segment: flags.segment,
      outputFile: flags['output-file'],
      resultFormat: flags['result-format'],
      includeDetails: flags['include-details'],
      dataSpace: flags['data-space'],
      fields: flags.fields,
      filters: flags.filters,
      orderBy: flags['order-by'],
      limit: flags.limit,
      offset: flags.offset,
      columnDelimiter: flags['column-delimiter'],
      lineEnding: flags['line-ending'],
      paginationLimits: {
        ...(flags['max-pages'] === undefined ? {} : { maxPages: flags['max-pages'] }),
        ...(flags['max-items'] === undefined ? {} : { maxItems: flags['max-items'] }),
        ...(flags['max-duration-ms'] === undefined ? {} : { maxDurationMs: flags['max-duration-ms'] }),
      },
    });
  }
}

/** Export basic endpoint rows or enriched details through one atomic destination transaction. */
export async function exportSegmentMembers(options: ExportOptions): Promise<SegmentMembersExportResult> {
  const includeDetails = options.includeDetails ?? false;
  const dataSpace = options.dataSpace ?? DEFAULT_DATA_SPACE;
  const delimiter = delimiterCharacter(options.columnDelimiter);
  const lineEnding = options.lineEnding === 'CRLF' ? '\r\n' : '\n';

  if (includeDetails) {
    rejectBasicOnlyOptions(options);
    const segment = await resolveSegment(options.client, options.segment);
    const segmentApiName = segment.apiName as string;
    const source = extractDetailSource(segment);
    const details = await querySegmentMemberDetails(options.client, source, {
      dataSpace,
      rowLimit: options.limit,
      paginationLimits: options.paginationLimits,
    });
    const rowsWritten = await writeAtomicOutput(options.outputFile, async ({ handle }) =>
      writeArrayRows(handle, details.rows, details.columns, options.resultFormat, delimiter, lineEnding)
    );
    return {
      segmentApiName,
      outputFile: options.outputFile,
      resultFormat: options.resultFormat,
      includeDetails: true,
      dataSpace,
      rowsWritten,
      complete: true,
      enriched: { objectApiName: source.segmentOnDmo, columns: details.columns },
    };
  }

  const { segmentApiName, request, pageSize } = await createSegmentMembersRequest(options.client, options.segment, {
    fields: options.fields,
    filters: options.filters,
    orderBy: options.orderBy,
    limit: options.limit,
    offset: options.offset,
  });
  const rowsWritten = await writeAtomicOutput(options.outputFile, async ({ handle }) =>
    writeObjectRows(
      handle,
      options.client.requestPages<SegmentMember>(request, pageSize, options.paginationLimits),
      options.resultFormat,
      delimiter,
      lineEnding
    )
  );
  return {
    segmentApiName,
    outputFile: options.outputFile,
    resultFormat: options.resultFormat,
    includeDetails: false,
    dataSpace,
    rowsWritten,
    complete: true,
  };
}

function rejectBasicOnlyOptions(options: ExportOptions): void {
  const unsupported = [
    options.fields === undefined ? undefined : '--fields',
    options.filters === undefined ? undefined : '--filters',
    options.orderBy === undefined ? undefined : '--order-by',
    options.offset === undefined || options.offset === 0 ? undefined : '--offset',
  ].filter((flag): flag is string => flag !== undefined);
  if (unsupported.length > 0) {
    throw new SfError(
      `${unsupported.join(', ')} ${
        unsupported.length === 1 ? 'is' : 'are'
      } only supported in basic mode and cannot be used with --include-details.`,
      'EnrichedModeBasicFlagError'
    );
  }
}

function extractDetailSource(segment: SegmentDescriptor): SegmentMemberDetailSource {
  const membership = segment.segmentMembershipDmo;
  const latestMembershipDmo =
    typeof membership === 'object' && membership !== null && !Array.isArray(membership)
      ? (membership as Record<string, unknown>).latestTable
      : undefined;
  const segmentOnDmo = segment.segmentOnApiName;
  if (typeof latestMembershipDmo !== 'string' || !latestMembershipDmo.trim()) {
    throw new SfError(
      'Segment detail response is missing segmentMembershipDmo.latestTable.',
      'InvalidSegmentMemberDetailSource'
    );
  }
  if (typeof segmentOnDmo !== 'string' || !segmentOnDmo.trim()) {
    throw new SfError('Segment detail response is missing segmentOnApiName.', 'InvalidSegmentMemberDetailSource');
  }
  return { latestMembershipDmo: latestMembershipDmo.trim(), segmentOnDmo: segmentOnDmo.trim() };
}

async function writeObjectRows(
  handle: Awaited<ReturnType<typeof import('node:fs/promises').open>>,
  pages: AsyncIterable<SegmentMember[]>,
  format: 'csv' | 'json',
  delimiter: string,
  lineEnding: string
): Promise<number> {
  let rowsWritten = 0;
  let fields: string[] | undefined;
  if (format === 'json') await handle.appendFile('[\n', 'utf8');
  for await (const page of pages) {
    for (const row of page) {
      /* eslint-disable no-await-in-loop -- rows are streamed in stable order */
      if (format === 'json') {
        await handle.appendFile(`${rowsWritten === 0 ? '' : ',\n'}  ${JSON.stringify(row)}`, 'utf8');
      } else {
        fields ??= Object.keys(row);
        if (rowsWritten === 0)
          await handle.appendFile(`${fields.map((field) => csvValue(field, delimiter)).join(delimiter)}${lineEnding}`);
        await handle.appendFile(
          `${fields.map((field) => csvValue(row[field], delimiter)).join(delimiter)}${lineEnding}`,
          'utf8'
        );
      }
      rowsWritten += 1;
      /* eslint-enable no-await-in-loop */
    }
  }
  if (format === 'json') await handle.appendFile('\n]\n', 'utf8');
  return rowsWritten;
}

async function writeArrayRows(
  handle: Awaited<ReturnType<typeof import('node:fs/promises').open>>,
  rows: AsyncIterable<readonly unknown[]>,
  columns: SegmentMemberDetailColumn[],
  format: 'csv' | 'json',
  delimiter: string,
  lineEnding: string
): Promise<number> {
  let rowsWritten = 0;
  if (format === 'json') await handle.appendFile('[\n', 'utf8');
  else
    await handle.appendFile(
      `${columns.map((column) => csvValue(column.name, delimiter)).join(delimiter)}${lineEnding}`
    );
  for await (const row of rows) {
    /* eslint-disable no-await-in-loop -- rows are streamed in stable order */
    if (format === 'json') {
      const value = Object.fromEntries(columns.map((column, index) => [column.name, row[index] ?? null]));
      await handle.appendFile(`${rowsWritten === 0 ? '' : ',\n'}  ${JSON.stringify(value)}`, 'utf8');
    } else {
      await handle.appendFile(`${row.map((value) => csvValue(value, delimiter)).join(delimiter)}${lineEnding}`, 'utf8');
    }
    rowsWritten += 1;
    /* eslint-enable no-await-in-loop */
  }
  if (format === 'json') await handle.appendFile('\n]\n', 'utf8');
  return rowsWritten;
}

function delimiterCharacter(delimiter: NonNullable<ExportOptions['columnDelimiter']> = 'COMMA'): string {
  return { BACKQUOTE: '`', CARET: '^', COMMA: ',', PIPE: '|', SEMICOLON: ';', TAB: '\t' }[delimiter];
}

function csvValue(value: unknown, delimiter: string): string {
  const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return text.includes(delimiter) || /["\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
