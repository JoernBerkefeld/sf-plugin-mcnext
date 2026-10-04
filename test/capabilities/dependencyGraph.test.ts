import { expect } from 'chai';
import {
  planDependencyGraph,
  portableIdentityKey,
  type DependencyGraphNodeInput,
} from '../../src/capabilities/dependencyGraph.js';
import type { PortableIdentity } from '../../src/capabilities/contracts.js';

const identity = (apiName: string): PortableIdentity => ({
  family: 'mcnext',
  type: 'Campaign',
  apiName,
  context: { packageDirectory: 'configured', workspace: 'origin', dataSpace: 'native' },
});
const key = (name: string): string => portableIdentityKey(identity(name));
const node = (name: string, targets: string[] = [], blockedReasons: string[] = []): DependencyGraphNodeInput => ({
  portableIdentity: identity(name),
  blockedReasons,
  dependencies: targets.map((target) => ({
    descriptor: {
      kind: 'reference',
      source: identity(name),
      target: identity(target),
      required: true,
      resolution: 'package',
    },
    resolution: { kind: 'package' },
  })),
});

describe('deterministic dependency graph', () => {
  it('orders chains, diamonds and disconnected components dependency-first', () => {
    const graph = planDependencyGraph([
      node('A', ['B', 'C']),
      node('B', ['D']),
      node('C', ['D']),
      node('D'),
      node('E'),
    ]);
    expect(graph.layers).to.deep.equal([[key('D'), key('E')], [key('B'), key('C')], [key('A')]]);
    expect(graph.components).to.deep.equal([[key('A'), key('B'), key('C'), key('D')], [key('E')]]);
    expect(graph.nodes[0].portableIdentity.context).to.deep.equal(identity('A').context);
    expect(planDependencyGraph([node('C'), node('B', ['C']), node('A', ['B'])]).layers).to.deep.equal([
      [key('C')],
      [key('B')],
      [key('A')],
    ]);
  });

  it('reports closed concrete paths for cycles and self-cycles and blocks their dependents', () => {
    const graph = planDependencyGraph([
      node('A', ['B']),
      node('B', ['C']),
      node('C', ['A']),
      node('D', ['A']),
      node('E', ['E']),
      node('F'),
    ]);
    expect(graph.cycles).to.deep.equal([
      [key('A'), key('B'), key('C'), key('A')],
      [key('E'), key('E')],
    ]);
    expect(graph.layers).to.deep.equal([[key('F')]]);
    expect(graph.nodes.find((item) => item.key === key('D'))!.blockedReasons.join(' ')).to.include('Dependency cycle');
  });

  it('propagates concrete failures through a diamond while leaving unrelated nodes ready', () => {
    const graph = planDependencyGraph([
      node('A', ['B', 'C']),
      node('B', ['D']),
      node('C', ['D']),
      node('D', [], ['provider unavailable']),
      node('E'),
    ]);
    expect(graph.nodes.find((item) => item.key === key('A'))!.blockedReasons.join(' ')).to.include(
      'provider unavailable'
    );
    expect(graph.layers).to.deep.equal([[key('E')]]);
  });

  it('retains present optional constraints unless omission has explicit semantics evidence', () => {
    const source = node('A', ['B']);
    source.dependencies[0].descriptor.required = false;
    expect(planDependencyGraph([source, node('B', [], ['unavailable'])]).nodes[0].ready).to.equal(false);
    source.dependencies[0].resolution = {
      kind: 'omitted',
      semanticsEvidence: 'captured optional binding may remain absent',
    };
    expect(planDependencyGraph([source, node('B', [], ['unavailable'])]).nodes[0].ready).to.equal(true);
    source.dependencies[0].descriptor.required = true;
    expect(() => planDependencyGraph([source, node('B')])).to.throw('optional references');
    source.dependencies[0].descriptor.required = false;
    source.dependencies[0].resolution = { kind: 'omitted', semanticsEvidence: ' ' };
    expect(() => planDependencyGraph([source, node('B')])).to.throw('optional references');
  });

  it('blocks unresolved optional and required references without inventing fallback', () => {
    for (const required of [true, false]) {
      const source = node('A', ['Missing']);
      source.dependencies[0].descriptor.required = required;
      source.dependencies[0].resolution = { kind: 'unresolved', reason: 'missing exact target evidence' };
      const graph = planDependencyGraph([source]);
      expect(graph.nodes[0].ready).to.equal(false);
      expect(graph.nodes[0].blockedReasons[0]).to.include('missing exact target evidence');
    }
  });

  it('produces identical detached output for shuffled nodes, edges and context keys', () => {
    const input = [node('A', ['B', 'C']), node('B', ['C']), node('C')];
    const expected = planDependencyGraph(input);
    const shuffled = structuredClone(input).reverse();
    for (const item of shuffled) {
      item.dependencies.reverse();
      item.portableIdentity.context = { dataSpace: 'native', workspace: 'origin', packageDirectory: 'configured' };
    }
    expect(planDependencyGraph(shuffled)).to.deep.equal(expected);
    input[0].portableIdentity.apiName = 'Changed';
    expect(expected.nodes[0].portableIdentity.apiName).to.equal('A');
  });

  it('rejects duplicate/conflicting identities, foreign owners and portable locator leaks', () => {
    expect(() => planDependencyGraph([node('A'), node('A', [], ['conflict'])])).to.throw('Duplicate or conflicting');
    const source = node('A', ['B']);
    source.dependencies[0].descriptor.source = identity('C');
    expect(() => planDependencyGraph([source, node('B')])).to.throw('owning operation');
    source.dependencies[0].descriptor.required = false;
    expect(() => planDependencyGraph([source, node('B')])).to.throw('owning operation');
    expect(() => portableIdentityKey({ ...identity('A'), context: { workspaceId: '0Zu000000000001AAA' } })).to.throw(
      'leak'
    );
    expect(() => portableIdentityKey({ ...identity('A'), apiName: '701000000000001AAA' })).to.throw('leak');
    const scoped = node('A');
    scoped.portableIdentity.context = { workspace: 'other' };
    expect(planDependencyGraph([node('A'), scoped]).nodes).to.have.length(2);
    expect(portableIdentityKey({ ...identity('A'), namespace: 'one' })).not.to.equal(key('A'));
  });
});
