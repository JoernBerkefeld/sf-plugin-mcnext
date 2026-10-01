import { open, unlink, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Messages, Org, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { McnClient, PageProgress, PaginationLimits } from '../../../../client/mcnClient.js';
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
const targetOrgFlag = Flags.requiredOrg({
  summary: messages.getMessage('flags.target-org.summary'),
}) as unknown as ReturnType<typeof Flags.string>;

export type SegmentMembersExportResult = {
  segmentApiName: string;
  outputFile: string;
  resultFormat: 'csv' | 'json';
  includeDetails: boolean;
  dataSpace: string;
  rowsWritten: number;
  columnHeaders: 'label' | 'api-name';
  complete: true;
  enriched?: {
    objectApiName: string;
    columns: SegmentMemberDetailColumn[];
  };
};

type ExportOptions = {
  client: McnClient;
  segment: string;
  outputFile?: string;
  resultFormat: 'csv' | 'json';
  columnHeaders?: 'label' | 'api-name';
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
  onSegmentResolved?: (segmentApiName: string) => void;
  onProgress?: (progress: PageProgress) => void;
};

export default class SegmentMembersExport extends SfCommand<SegmentMembersExportResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:segment:members:export'];

  public static readonly flags = {
    'target-org': targetOrgFlag,
    segment: Flags.string({
      char: 's',
      required: true,
      summary: messages.getMessage('flags.segment.summary'),
    }),
    'output-file': Flags.string({
      summary: messages.getMessage('flags.output-file.summary'),
    }),
    'result-format': Flags.option({
      options: ['csv', 'json'] as const,
      default: 'csv',
      summary: messages.getMessage('flags.result-format.summary'),
    })(),
    'column-headers': Flags.option({
      options: ['label', 'api-name'] as const,
      default: 'label',
      summary: messages.getMessage('flags.column-headers.summary'),
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
    const resolvedOrg = flags['target-org'] as unknown as { getUsername: () => string };
    const org = await Org.create({ aliasOrUsername: resolvedOrg.getUsername() });
    const client = await McnClient.create(org, flags['api-version']);

    const result = await exportSegmentMembers({
      client,
      segment: flags.segment,
      outputFile: flags['output-file'],
      resultFormat: flags['result-format'],
      columnHeaders: flags['column-headers'],
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
      onSegmentResolved: (segmentApiName) =>
        this.logToStderr(`Found segment ${segmentApiName}. Starting download.`),
      onProgress: ({ batch, expectedBatches }) =>
        this.logToStderr(`Downloading batch ${batch}${expectedBatches === undefined ? '' : ` of ${expectedBatches}`}`),
    });
    this.logToStderr(`Saved ${result.rowsWritten} segment members to ${result.outputFile}`);
    return result;
  }
}

/** Export basic endpoint rows or enriched details through one atomic destination transaction. */
export async function exportSegmentMembers(options: ExportOptions): Promise<SegmentMembersExportResult> {
  const includeDetails = options.includeDetails ?? false;
  const dataSpace = options.dataSpace ?? DEFAULT_DATA_SPACE;
  const columnHeaders = options.columnHeaders ?? 'label';
  const delimiter = delimiterCharacter(options.columnDelimiter);
  const lineEnding = options.lineEnding === 'CRLF' ? '\r\n' : '\n';

  if (includeDetails) {
    rejectBasicOnlyOptions(options);
    const segment = await resolveSegment(options.client, options.segment);
    const segmentApiName = segment.apiName as string;
    options.onSegmentResolved?.(segmentApiName);
    const source = extractDetailSource(segment);
    const details = await querySegmentMemberDetails(options.client, source, {
      dataSpace,
      rowLimit: options.limit,
      paginationLimits: options.paginationLimits,
      onProgress: options.onProgress,
    });
    const destination = await resolveOutputFile(
      options.outputFile,
      segment.displayName ?? segmentApiName,
      options.resultFormat
    );
    const outputFile = destination.path;
    const rowsWritten = await writeReservedOutput(destination, async ({ handle }) =>
      writeArrayRows(handle, details.rows, details.columns, columnHeaders, options.resultFormat, delimiter, lineEnding)
    );
    return {
      segmentApiName,
      outputFile,
      resultFormat: options.resultFormat,
      includeDetails: true,
      dataSpace,
      rowsWritten,
      columnHeaders,
      complete: true,
      enriched: { objectApiName: source.segmentOnDmo, columns: details.columns },
    };
  }

  const requestOptions = {
    fields: options.fields,
    filters: options.filters,
    orderBy: options.orderBy,
    limit: options.limit,
    offset: options.offset,
  };
  const generatedSegment = options.outputFile === undefined ? await resolveSegment(options.client, options.segment) : undefined;
  const resolved = await createSegmentMembersRequest(
    options.client,
    options.segment,
    requestOptions,
    generatedSegment?.apiName
  );
  const segmentApiName = resolved.segmentApiName;
  const { request, pageSize } = resolved;
  const destination = await resolveOutputFile(
    options.outputFile,
    generatedSegment?.displayName ?? segmentApiName,
    options.resultFormat
  );
  const outputFile = destination.path;
  options.onSegmentResolved?.(segmentApiName);
  const rowsWritten = await writeReservedOutput(destination, async ({ handle }) =>
    writeObjectRows(
      handle,
      options.client.requestPages<SegmentMember>(request, pageSize, options.paginationLimits, options.onProgress),
      options.resultFormat,
      delimiter,
      lineEnding
    )
  );
  return {
    segmentApiName,
    outputFile,
    resultFormat: options.resultFormat,
    includeDetails: false,
    dataSpace,
    rowsWritten,
    columnHeaders: 'api-name',
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
  columnHeaders: 'label' | 'api-name',
  format: 'csv' | 'json',
  delimiter: string,
  lineEnding: string
): Promise<number> {
  let rowsWritten = 0;
  const headers = resolveColumnHeaders(columns, columnHeaders);
  if (format === 'json') await handle.appendFile('[\n', 'utf8');
  else await handle.appendFile(`${headers.map((header) => csvValue(header, delimiter)).join(delimiter)}${lineEnding}`);
  for await (const row of rows) {
    /* eslint-disable no-await-in-loop -- rows are streamed in stable order */
    const normalized = columns.map((column, index) => normalizeFieldValue(row[index], column.dataType));
    if (format === 'json') {
      const value = Object.fromEntries(headers.map((header, index) => [header, normalized[index] ?? null]));
      await handle.appendFile(`${rowsWritten === 0 ? '' : ',\n'}  ${JSON.stringify(value)}`, 'utf8');
    } else {
      await handle.appendFile(
        `${normalized.map((value) => csvValue(value, delimiter)).join(delimiter)}${lineEnding}`,
        'utf8'
      );
    }
    rowsWritten += 1;
    /* eslint-enable no-await-in-loop */
  }
  if (format === 'json') await handle.appendFile('\n]\n', 'utf8');
  return rowsWritten;
}

export function resolveColumnHeaders(
  columns: SegmentMemberDetailColumn[],
  mode: 'label' | 'api-name'
): string[] {
  const occupied = new Set<string>();
  return columns.map((column) => {
    const base = mode === 'label' ? column.label.trim() || column.name : column.name;
    let candidate = base;
    let suffix = 2;
    while (occupied.has(candidate)) candidate = `${base}_${suffix++}`;
    occupied.add(candidate);
    return candidate;
  });
}

export function normalizeFieldValue(value: unknown, dataType?: string): unknown {
  if (value === null || value === undefined || typeof value !== 'string') return value;
  const normalizedType = dataType?.trim().toLowerCase();
  if (normalizedType === 'date') {
    const match = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/u.exec(value);
    return match?.[1] ?? value;
  }
  if (normalizedType === 'datetime') return value.replace(/^(\d{4}-\d{2}-\d{2})T/u, '$1 ');
  return value;
}

export function sanitizeFilename(value: string): string {
  const sanitized = [...value]
    .map((character) => (character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/u.test(character) ? '-' : character))
    .join('')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/[-. ]+$/gu, '')
    .replace(/^[. ]+/gu, '');
  const safe = sanitized || 'segment-members';
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(safe) ? `segment-${safe}` : safe;
}

type ResolvedOutputFile = { path: string; reservation?: FileHandle };

async function resolveOutputFile(
  requested: string | undefined,
  segmentName: string,
  format: 'csv' | 'json'
): Promise<ResolvedOutputFile> {
  if (requested !== undefined) return { path: resolve(requested) };
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(
    2,
    '0'
  )}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(
    now.getSeconds()
  ).padStart(2, '0')}`;
  const stem = `${sanitizeFilename(segmentName)}-${timestamp}`;
  for (let suffix = 1; ; suffix++) {
    const candidate = resolve(`${stem}${suffix === 1 ? '' : `_${suffix}`}.${format}`);
    try {
      // eslint-disable-next-line no-await-in-loop -- each exclusive reservation depends on the prior collision
      const reservation = await open(candidate, 'wx');
      return { path: candidate, reservation };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

async function writeReservedOutput<T>(
  destination: ResolvedOutputFile,
  writer: Parameters<typeof writeAtomicOutput<T>>[1]
): Promise<T> {
  if (destination.reservation === undefined) return writeAtomicOutput(destination.path, writer);

  try {
    await destination.reservation.close();
    return await writeAtomicOutput(destination.path, writer);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await destination.reservation.close();
    } catch (closeError) {
      if ((closeError as NodeJS.ErrnoException).code !== 'EBADF') cleanupErrors.push(closeError);
    }
    try {
      await unlink(destination.path);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors]);
    throw error;
  }
}

function delimiterCharacter(delimiter: NonNullable<ExportOptions['columnDelimiter']> = 'COMMA'): string {
  return { BACKQUOTE: '`', CARET: '^', COMMA: ',', PIPE: '|', SEMICOLON: ';', TAB: '\t' }[delimiter];
}

function csvValue(value: unknown, delimiter: string): string {
  const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return text.includes(delimiter) || /["\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
