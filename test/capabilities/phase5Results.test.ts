import { expect } from 'chai';
import {
  assertPhase5Result,
  dependencyGraphResult,
  deployPreflightResult,
  portableRetrievalResult,
} from '../../src/capabilities/phase5Results.js';
import { planDependencyGraph, type DependencyGraphNodeInput } from '../../src/capabilities/dependencyGraph.js';
import { planDeployPreflight } from '../../src/capabilities/deployPreflight.js';

const identity = (apiName: string) => ({ family: 'mcnext', type: 'Campaign', apiName });
const nodes: DependencyGraphNodeInput[] = [
  {
    portableIdentity: identity('root'),
    blockedReasons: [],
    dependencies: [
      {
        descriptor: {
          kind: 'reference',
          source: identity('root'),
          target: identity('missing'),
          required: true,
          resolution: 'target',
        },
        resolution: { kind: 'unresolved', reason: 'missing exact evidence' },
      },
    ],
  },
  { portableIdentity: identity('independent'), blockedReasons: [], dependencies: [] },
];

describe('strict MCNext Phase 5 results', () => {
  it('counts real graph outcomes and stays deterministic under input permutations', () => {
    const report = dependencyGraphResult(planDependencyGraph(nodes));
    expect(report).to.deep.equal(dependencyGraphResult(planDependencyGraph([...nodes].reverse())));
    expect(report.metrics).to.deep.include({
      dependencies: 1,
      blockedDependencies: 1,
      resolvedDependencies: 0,
      blockedNodes: 1,
      readyNodes: 1,
      omittedDependencies: 0,
    });
    expect(report.warnings.join(' ')).to.include('missing exact evidence');
    assertPhase5Result(JSON.parse(JSON.stringify(report)), report);
  });

  it('rejects malformed, unknown, unsupported and inconsistent reports', () => {
    const report = dependencyGraphResult(planDependencyGraph(nodes));
    for (const bad of [
      null,
      { ...report, unknown: true },
      { ...report, version: '1.1.0' },
      { ...report, contract: 'sf-cms-phase5-result-v1' },
      { ...report, warnings: [''] },
      { ...report, metrics: { ...report.metrics, resolvedDependencies: 1 } },
      { ...report, metrics: { ...report.metrics, blockedDependencies: -1 } },
      { ...report, metrics: { ...report.metrics, nodes: 0.5 } },
      { ...report, metrics: { ...report.metrics, extra: 0 } },
      { ...report, reportHash: '0'.repeat(64) },
    ])
      expect(() => assertPhase5Result(bad, report)).to.throw();
  });

  it('does not invent strategy calls from a zero-mutation preflight', () => {
    const report = deployPreflightResult(planDeployPreflight([]));
    expect(report.metrics).to.deep.equal({
      routes: 0,
      readyRoutes: 0,
      blockedRoutes: 0,
      evaluatedOperations: 0,
      dependencies: 0,
      resolvedDependencies: 0,
      blockedDependencies: 0,
      omittedDependencies: 0,
    });
    expect(report.metrics).not.to.have.property('calls');
    assertPhase5Result(report, deployPreflightResult(planDeployPreflight([])));
  });

  it('reports optional omission evidence independently of resolution', () => {
    const optional = structuredClone(nodes);
    optional[0].dependencies[0].descriptor.required = false;
    optional[0].dependencies[0].resolution = {
      kind: 'omitted',
      semanticsEvidence: 'explicitly non-semantic decoration',
    };
    const report = dependencyGraphResult(planDependencyGraph(optional));
    expect(report.metrics).to.deep.include({ omittedDependencies: 1, resolvedDependencies: 0, blockedDependencies: 0 });
    expect(report.warnings.join(' ')).to.include('non-semantic decoration');
  });

  it('requires completion observations only on the actual miss branch', () => {
    const sidecar = {
      contract: 'sf-mcnext-portable-retrieval-v1' as const,
      version: '1.0.0' as const,
      portableIdentity: identity('root'),
      role: 'artifact-identity' as const,
      deployableDefinition: false as const,
      contentHash: '0'.repeat(64),
    };
    const completion = {
      strategy: 'targeted' as const,
      completionProof: 'exact',
      calls: 1,
      items: 1,
      pages: 1,
      complete: true,
    };
    expect(() => portableRetrievalResult(sidecar, true, completion)).to.throw('branch mismatch');
    expect(() => portableRetrievalResult(sidecar, false)).to.throw('branch mismatch');
    const report = portableRetrievalResult(sidecar, false, completion);
    assertPhase5Result(report, portableRetrievalResult(sidecar, false, completion));
  });
});
