import { open } from 'node:fs/promises';
import { Messages, Org, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { McnClient, PaginationLimits } from '../../../../client/mcnClient.js';
import { FormatWriter } from '../../../../format/formatWriter.js';
import { createSegmentMembersRequest, SegmentMember } from '../../../../segment/segmentMembers.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.segment.members.export');

const DEFAULT_PAGE_SIZE = 200;

export type SegmentMembersExportResult = {
  segmentApiName: string;
  outputFile: string;
  resultFormat: 'csv' | 'json';
  rowsWritten: number;
  complete: true;
};

type ExportOptions = {
  client: McnClient;
  segment: string;
  outputFile: string;
  resultFormat: 'csv' | 'json';
  fields?: string;
  filters?: string;
  orderBy?: string;
  limit: number;
  offset: number;
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

/** Export every returned segment-member page incrementally to CSV or JSON. */
export async function exportSegmentMembers(options: ExportOptions): Promise<SegmentMembersExportResult> {
  const { segmentApiName, request, pageSize } = await createSegmentMembersRequest(options.client, options.segment, {
    fields: options.fields,
    filters: options.filters,
    orderBy: options.orderBy,
    limit: options.limit,
    offset: options.offset,
  });
  await FormatWriter.ensureDir(options.outputFile);
  const file = await open(options.outputFile, 'w');
  let rowsWritten = 0;
  let csvFields: string[] | undefined;
  const delimiter = delimiterCharacter(options.columnDelimiter);
  const lineEnding = options.lineEnding === 'CRLF' ? '\r\n' : '\n';

  try {
    if (options.resultFormat === 'json') await file.appendFile('[\n', 'utf8');

    for await (const page of options.client.requestPages<SegmentMember>(
      request,
      pageSize,
      options.paginationLimits
    )) {
      for (const row of page) {
        /* eslint-disable no-await-in-loop -- rows are deliberately streamed in order with bounded memory */
        if (options.resultFormat === 'json') {
          await file.appendFile(`${rowsWritten === 0 ? '' : ',\n'}  ${JSON.stringify(row)}`, 'utf8');
        } else {
          csvFields ??= Object.keys(row);
          if (rowsWritten === 0) {
            await file.appendFile(`${csvFields.map((field) => csvValue(field, delimiter)).join(delimiter)}${lineEnding}`);
          }
          await file.appendFile(
            `${csvFields.map((field) => csvValue(row[field], delimiter)).join(delimiter)}${lineEnding}`,
            'utf8'
          );
        }
        rowsWritten += 1;
        /* eslint-enable no-await-in-loop */
      }
    }

    if (options.resultFormat === 'json') await file.appendFile('\n]\n', 'utf8');
  } catch (error) {
    throw new SfError(
      `Segment member export stopped after ${rowsWritten} row(s); ${options.outputFile} is incomplete. ${(error as Error).message}`,
      'IncompleteSegmentMemberExportError',
      undefined,
      error as Error
    );
  } finally {
    await file.close();
  }

  return {
    segmentApiName,
    outputFile: options.outputFile,
    resultFormat: options.resultFormat,
    rowsWritten,
    complete: true,
  };
}

function delimiterCharacter(
  delimiter: NonNullable<ExportOptions['columnDelimiter']> = 'COMMA'
): string {
  return { BACKQUOTE: '`', CARET: '^', COMMA: ',', PIPE: '|', SEMICOLON: ';', TAB: '\t' }[delimiter];
}

function csvValue(value: unknown, delimiter: string): string {
  const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return text.includes(delimiter) || /["\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
