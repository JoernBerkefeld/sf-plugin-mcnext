import { expect } from 'chai';
import { parseSegmentCoreResult } from '../../src/segment/segmentDefinitionCli.js';

const member = 'FreshSegment';
const success = (operation: 'validate' | 'create' | 'retrieve') => ({
  id: `${operation}-job`,
  status: 'Succeeded',
  done: true,
  success: true,
  checkOnly: operation === 'validate',
  files: [
    {
      type: 'MarketSegmentDefinition',
      fullName: member,
      state: operation === 'create' ? 'Created' : 'Changed',
      filePath: `force-app/main/default/marketSegmentDefinitions/${member}.marketSegmentDefinition-meta.xml`,
    },
  ],
});

const response = (result: unknown, exitCode = 0, status = exitCode) => ({
  stdout: JSON.stringify({ status, result }),
  exitCode,
});

describe('Segment Definition Core adapter', () => {
  it('accepts terminal check-only, created, and retrieve envelopes for exactly one member', () => {
    for (const operation of ['validate', 'create', 'retrieve'] as const)
      expect(parseSegmentCoreResult(operation, member, response(success(operation)))).to.include({
        operation,
        member,
        jobId: `${operation}-job`,
      });
  });

  it('rejects malformed, nonterminal, partial, unchanged, mismatched and duplicate envelopes', () => {
    const cases = [
      { stdout: '{bad', exitCode: 0 },
      { stdout: '{}', exitCode: 0 },
      response(success('create'), 0, 1),
      response({ ...success('create'), status: 'InProgress', done: false, success: false }, 69),
      response({ ...success('create'), status: 'SucceededPartial' }),
      response({ ...success('create'), checkOnly: true }),
      response({ ...success('create'), files: [{ ...success('create').files[0], state: 'Unchanged' }] }),
      response({ ...success('create'), files: [{ ...success('create').files[0], fullName: 'Other' }] }),
      response({ ...success('create'), files: [success('create').files[0], success('create').files[0]] }),
    ];
    for (const item of cases) expect(() => parseSegmentCoreResult('create', member, item)).to.throw();
  });
});
