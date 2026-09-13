import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import SegmentRecordsExport, {
  buildDelegatedArgs,
} from '../../../../../src/commands/mcnext/segment/records/export.js';

const QUERY = 'SELECT Id, Name, MarketSegmentType, SegmentStatus, PublishStatus FROM MarketSegment';

describe('mcnext segment records export', () => {
  const $$ = new TestContext();

  afterEach(() => {
    $$.restore();
  });

  it('builds the exact core command arguments from verified fields and defaults', async () => {
    const command = Object.create(SegmentRecordsExport.prototype) as SegmentRecordsExport;
    const runCommand = $$.SANDBOX.stub().resolves({ jobId: '750xx' });
    const log = $$.SANDBOX.stub();

    Object.assign(command, {
      config: { runCommand },
      log,
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'test@example.com',
          'output-file': 'segments.csv',
          'result-format': 'csv',
          wait: 10,
          'all-rows': false,
        },
      }),
    });

    const result = await command.run();

    expect(
      runCommand.calledOnceWithExactly('data export bulk', [
        '--query',
        QUERY,
        '--output-file',
        'segments.csv',
        '--result-format',
        'csv',
        '--wait',
        '10',
        '--target-org',
        'test@example.com',
      ])
    ).to.equal(true);
    expect(
      log.calledOnceWithExactly(
        'Delegating to core Salesforce CLI: sf data export bulk --query "SELECT Id, Name, MarketSegmentType, SegmentStatus, PublishStatus FROM MarketSegment" --output-file segments.csv --result-format csv --wait 10 --target-org test@example.com'
      )
    ).to.equal(true);
    expect(result).to.deep.equal({
      delegatedCommand:
        'sf data export bulk --query "SELECT Id, Name, MarketSegmentType, SegmentStatus, PublishStatus FROM MarketSegment" --output-file segments.csv --result-format csv --wait 10 --target-org test@example.com',
      result: { jobId: '750xx' },
    });
  });

  it('passes through relevant optional output and query flags', () => {
    expect(
      buildDelegatedArgs({
        query: QUERY,
        targetOrg: 'my-org',
        outputFile: 'segments.json',
        resultFormat: 'json',
        wait: 0,
        apiVersion: '67.0',
        allRows: true,
        columnDelimiter: 'PIPE',
        lineEnding: 'LF',
      })
    ).to.deep.equal([
      '--query',
      QUERY,
      '--output-file',
      'segments.json',
      '--result-format',
      'json',
      '--wait',
      '0',
      '--target-org',
      'my-org',
      '--api-version',
      '67.0',
      '--all-rows',
      '--column-delimiter',
      'PIPE',
      '--line-ending',
      'LF',
    ]);
  });

  it('propagates failures from the delegated core command', async () => {
    const command = Object.create(SegmentRecordsExport.prototype) as SegmentRecordsExport;
    const failure = new Error('bulk export failed');

    Object.assign(command, {
      config: { runCommand: $$.SANDBOX.stub().rejects(failure) },
      log: $$.SANDBOX.stub(),
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'test@example.com',
          'output-file': 'segments.csv',
          'result-format': 'csv',
          wait: 10,
          'all-rows': false,
        },
      }),
    });

    let caught: unknown;
    try {
      await command.run();
    } catch (error) {
      caught = error;
    }

    expect(caught).to.equal(failure);
  });
});
