import { Messages, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { getType } from '../../../../registry/registry.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.segment.records.export');

const DELEGATED_COMMAND = 'data export bulk';

export type SegmentRecordsExportResult = {
  delegatedCommand: string;
  result: unknown;
};

export default class SegmentRecordsExport extends SfCommand<SegmentRecordsExportResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:segment:records:export'];

  public static readonly flags = {
    'target-org': Flags.string({
      // eslint-disable-next-line sf-plugin/dash-o -- target-org convention intentionally uses -o
      char: 'o',
      required: true,
      summary: messages.getMessage('flags.target-org.summary'),
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
    wait: Flags.integer({
      char: 'w',
      default: 10,
      min: 0,
      summary: messages.getMessage('flags.wait.summary'),
    }),
    'api-version': Flags.orgApiVersion({
      summary: messages.getMessage('flags.api-version.summary'),
    }),
    'all-rows': Flags.boolean({
      default: false,
      summary: messages.getMessage('flags.all-rows.summary'),
    }),
    'column-delimiter': Flags.option({
      options: ['BACKQUOTE', 'CARET', 'COMMA', 'PIPE', 'SEMICOLON', 'TAB'] as const,
      summary: messages.getMessage('flags.column-delimiter.summary'),
    })(),
    'line-ending': Flags.option({
      options: ['LF', 'CRLF'] as const,
      summary: messages.getMessage('flags.line-ending.summary'),
    })(),
  };

  public async run(): Promise<SegmentRecordsExportResult> {
    const { flags } = await this.parse(SegmentRecordsExport);
    const delegation = getType('marketSegmentRecord')?.delegation;
    if (!delegation?.sObject || !delegation.fields?.length) {
      throw new SfError('MarketSegment core CLI delegation is not configured.', 'MissingSegmentRecordDelegation');
    }

    const query = `SELECT ${delegation.fields.join(', ')} FROM ${delegation.sObject}`;
    const args = buildDelegatedArgs({
      query,
      targetOrg: flags['target-org'],
      outputFile: flags['output-file'],
      resultFormat: flags['result-format'],
      wait: flags.wait,
      apiVersion: flags['api-version'],
      allRows: flags['all-rows'],
      columnDelimiter: flags['column-delimiter'],
      lineEnding: flags['line-ending'],
    });
    const delegatedCommand = formatDelegatedCommand(args);

    this.log(`Delegating to core Salesforce CLI: ${delegatedCommand}`);
    const result = await this.config.runCommand(DELEGATED_COMMAND, args);
    return { delegatedCommand, result };
  }
}

type DelegatedOptions = {
  query: string;
  targetOrg: string;
  outputFile: string;
  resultFormat: 'csv' | 'json';
  wait: number;
  apiVersion?: string;
  allRows: boolean;
  columnDelimiter?: 'BACKQUOTE' | 'CARET' | 'COMMA' | 'PIPE' | 'SEMICOLON' | 'TAB';
  lineEnding?: 'LF' | 'CRLF';
};

/** Build argv for the installed core Salesforce CLI bulk export command. */
export function buildDelegatedArgs(options: DelegatedOptions): string[] {
  const args = [
    '--query',
    options.query,
    '--output-file',
    options.outputFile,
    '--result-format',
    options.resultFormat,
    '--wait',
    String(options.wait),
    '--target-org',
    options.targetOrg,
  ];

  if (options.apiVersion) args.push('--api-version', options.apiVersion);
  if (options.allRows) args.push('--all-rows');
  if (options.columnDelimiter) args.push('--column-delimiter', options.columnDelimiter);
  if (options.lineEnding) args.push('--line-ending', options.lineEnding);

  return args;
}

/** Render copyable provenance without using a shell to invoke the delegated command. */
function formatDelegatedCommand(args: string[]): string {
  return `sf ${DELEGATED_COMMAND} ${args.map(quoteArgument).join(' ')}`;
}

function quoteArgument(argument: string): string {
  return /\s/u.test(argument) ? `"${argument.replaceAll('"', '\\"')}"` : argument;
}
