import { expect } from 'chai';
import { emptyEnvelope, exitCodeOf, statusOf, type Item, type Outcome, type Status } from '../src/envelope.js';

const item = (outcome: Outcome): Item => ({ area: 'mcnext', type: 'campaign', name: outcome, outcome });
const items = (...outcomes: Outcome[]): Item[] => outcomes.map(item);

describe('envelope status rule', () => {
  it('is 0 for no items and no phase codes', () => {
    expect(statusOf([], [])).to.equal(0);
  });

  it('is 0 when every item succeeded, was previewed or was not attempted', () => {
    const clean: Outcome[] = [
      'created',
      'updated',
      'unchanged',
      'deleted',
      'retrieved',
      'would-create',
      'would-update',
      'would-delete',
      'not-attempted',
    ];
    expect(statusOf(items(...clean), [0, 0])).to.equal(0);
  });

  for (const problem of ['failed', 'blocked', 'unknown'] as const) {
    it(`is 1 for a ${problem} item when nothing is confirmed written`, () => {
      expect(statusOf(items(problem), [])).to.equal(1);
      expect(statusOf(items(problem, 'unchanged', 'would-create', 'not-attempted'), [0])).to.equal(1);
    });

    for (const written of ['created', 'updated', 'deleted', 'retrieved'] as const) {
      it(`is 68 for a ${problem} item next to a ${written} item`, () => {
        expect(statusOf(items(written, problem), [])).to.equal(68);
      });
    }
  }

  it('lets a failing item win over the phase codes', () => {
    expect(statusOf(items('failed'), [69])).to.equal(1);
    expect(statusOf(items('created', 'blocked'), [69, 1])).to.equal(68);
  });

  it('is 68 when an item failed and a phase confirmed a write', () => {
    expect(statusOf(items('failed'), [68])).to.equal(68);
  });

  it('is 68 when a phase failed and an own item was written', () => {
    expect(statusOf(items('created'), [1])).to.equal(68);
    expect(statusOf(items('unchanged'), [1])).to.equal(1);
  });

  it('takes the phase code when nothing here was written or failed', () => {
    for (const code of [0, 1, 68, 69] as const) {
      expect(statusOf([], [0, code]), `phase 0 and ${code}`).to.equal(code);
    }
    expect(statusOf(items('created'), [69])).to.equal(69);
    expect(statusOf(items('created'), [0])).to.equal(0);
  });

  it('lets 1 and 68 win over 69, in either order', () => {
    const cases: Array<[Status[], Status]> = [
      [[1, 69], 1],
      [[69, 1], 1],
      [[68, 69], 68],
      [[69, 68], 68],
      [[69, 0], 69],
      [[69, 69], 69],
    ];
    for (const [codes, expected] of cases) expect(statusOf([], codes), codes.join('+')).to.equal(expected);
  });

  it('is 68 when one phase failed and the other wrote part of its work', () => {
    expect(statusOf([], [1, 68])).to.equal(68);
    expect(statusOf([], [68, 1])).to.equal(68);
  });
});

describe('envelope helpers', () => {
  it('builds an empty envelope with status 0', () => {
    expect(emptyEnvelope('deploy', true, '00D000000000001AAA')).to.deep.equal({
      status: 0,
      operation: 'deploy',
      preview: true,
      orgId: '00D000000000001AAA',
      items: [],
      areas: {},
      warnings: [],
      errors: [],
    });
  });

  it('does not share arrays between envelopes', () => {
    const first = emptyEnvelope('list', false, '00D000000000001AAA');
    first.items.push(item('retrieved'));
    first.warnings.push('one');
    expect(emptyEnvelope('list', false, '00D000000000001AAA').items).to.deep.equal([]);
    expect(emptyEnvelope('list', false, '00D000000000001AAA').warnings).to.deep.equal([]);
  });

  it('uses the status as the exit code', () => {
    for (const status of [0, 1, 68, 69] as const) {
      expect(exitCodeOf({ ...emptyEnvelope('delete', false, '00D000000000001AAA'), status })).to.equal(status);
    }
  });
});
