import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import FlowSource from '../../../../src/commands/mcnext/flow/source.js';

describe('mcnext flow source command', () => {
  const $$ = new TestContext();
  beforeEach(() => {
    stubSfCommandUx($$.SANDBOX);
  });
  afterEach(() => {
    $$.restore();
  });

  it('exposes only retrieve and non-mutating validation with required explicit selections', () => {
    expect(FlowSource.flags.operation.options).to.deep.equal(['retrieve', 'validate', 'create', 'update']);
    for (const flag of ['operation', 'member', 'target-org', 'project-dir'] as const) {
      expect(FlowSource.flags[flag].required).to.equal(true);
    }
    expect(FlowSource.description).to.include('never falls back to CREATE');
  });

  it('rejects execution operations and undeclared or cross-org reference reuse', async () => {
    await Promise.all(
      ['activate', 'run', 'publish', 'update'].map(async (operation) => {
        let failure: unknown;
        try {
          await FlowSource.run([
            '--operation',
            operation,
            '--member',
            'FreshFlow',
            '--target-org',
            'target',
            '--project-dir',
            '.',
          ]);
        } catch (error) {
          failure = error;
        }
        expect(failure).to.be.instanceOf(Error);
      })
    );
    const args = [
      '--operation',
      'create',
      '--member',
      'FreshFlow',
      '--target-org',
      'target',
      '--project-dir',
      '.',
      '--source-file',
      'example.flow-meta.xml',
      '--expected-org-id',
      '00D000000000000AAA',
    ];
    let failure: unknown;
    try {
      await FlowSource.run(args);
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).to.include('same-org');
    try {
      await FlowSource.run([...args, '--source-org-id', '00D000000000001AAA', '--reuse-same-org-references']);
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).to.include('cross-org');
  });

  it('rejects wildcard selections before any Core subprocess can run', async () => {
    let failure: unknown;
    try {
      await FlowSource.run([
        '--operation',
        'retrieve',
        '--member',
        '*',
        '--target-org',
        'target',
        '--project-dir',
        '.',
      ]);
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.include('exact Flow');
  });
});
