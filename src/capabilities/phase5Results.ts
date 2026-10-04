import { createHash } from 'node:crypto';
import type { DeployPreflightReport } from './deployPreflight.js';
import type { DependencyGraphPlan } from './dependencyGraph.js';
import type { CompletionEvidence } from './portableResolution.js';
import type { PortableRetrievalSidecar } from './retrievalPersistence.js';

export const PHASE5_RESULT_CONTRACT = 'sf-mcnext-phase5-result-v1' as const;
export const PHASE5_RESULT_VERSION = '1.0.0' as const;

export type Phase5Result = {
  contract: typeof PHASE5_RESULT_CONTRACT;
  version: typeof PHASE5_RESULT_VERSION;
  kind: 'portable-retrieval' | 'deploy-preflight' | 'dependency-graph';
  resultHash: string;
  metrics: Record<string, number>;
  warnings: string[];
  reportHash: string;
};

/** Report actual cache branch actions and supplied bounded completion evidence, never inferred wire calls. */
export function portableRetrievalResult(
  sidecar: PortableRetrievalSidecar,
  cacheHit: boolean,
  completion?: CompletionEvidence
): Phase5Result {
  if (cacheHit === (completion !== undefined)) throw new Error('Retrieval completion/cache branch mismatch');
  return finalize(
    'portable-retrieval',
    sidecar,
    {
      cacheHits: cacheHit ? 1 : 0,
      cacheMisses: cacheHit ? 0 : 1,
      cacheRefreshes: cacheHit ? 0 : 1,
      loaderCalls: cacheHit ? 0 : 1,
      ...(completion === undefined
        ? {}
        : {
            evidenceCalls: completion.calls,
            evidenceItems: completion.items,
            evidencePages: completion.pages,
          }),
    },
    [
      'Portable retrieval is a helper-only sidecar seam, not command-integrated decomposed retrieval.',
      'Completion counts describe supplied evidence; loader calls are not measured Salesforce wire calls.',
      ...(cacheHit ? ['A cache hit skips loading but does not prove fresh target revalidation.'] : []),
    ]
  );
}

/** Count edge resolution states separately from blocked nodes and optional omissions. */
export function dependencyGraphResult(graph: DependencyGraphPlan): Phase5Result {
  return finalize(
    'dependency-graph',
    graph,
    {
      nodes: graph.nodes.length,
      readyNodes: graph.nodes.filter((node) => node.ready).length,
      blockedNodes: graph.nodes.filter((node) => !node.ready).length,
      dependencies: graph.edges.length,
      resolvedDependencies: graph.edges.filter((edge) => ['package', 'target'].includes(edge.resolution.kind)).length,
      blockedDependencies: graph.edges.filter((edge) => edge.resolution.kind === 'unresolved').length,
      omittedDependencies: graph.edges.filter((edge) => edge.resolution.kind === 'omitted').length,
      cycles: graph.cycles.length,
    },
    [
      ...graph.nodes.flatMap((node) => node.blockedReasons.map((reason) => `${node.key}: ${reason}`)),
      ...graph.edges.flatMap((edge) =>
        edge.resolution.kind === 'omitted'
          ? [`Optional dependency ${edge.sourceKey} -> ${edge.targetKey} omitted: ${edge.resolution.semanticsEvidence}`]
          : []
      ),
    ]
  );
}

/** Count evaluated dependency occurrences; blocked routes with no operations claim no dependency measurements. */
export function deployPreflightResult(report: DeployPreflightReport): Phase5Result {
  const operations = report.routes.flatMap((route) => route.operations);
  const dependencies = operations.flatMap((operation) => operation.dependencies);
  return finalize(
    'deploy-preflight',
    report,
    {
      routes: report.routes.length,
      readyRoutes: report.routes.filter((route) => route.status === 'ready').length,
      blockedRoutes: report.routes.filter((route) => route.status === 'blocked').length,
      evaluatedOperations: operations.length,
      dependencies: dependencies.length,
      resolvedDependencies: dependencies.filter((dependency) => dependency.resolution !== null).length,
      blockedDependencies: dependencies.filter((dependency) => dependency.blockedReason !== undefined).length,
      omittedDependencies: dependencies.filter((dependency) => dependency.omission !== undefined).length,
    },
    [
      ...report.routes.flatMap((route) => route.blockedReasons.map((reason) => `${route.routeId}: ${reason}`)),
      ...dependencies.flatMap((dependency) =>
        dependency.omission === undefined
          ? []
          : [`Optional dependency ${dependency.descriptorHash} omitted: ${dependency.omission.semanticsEvidence}`]
      ),
    ]
  );
}

/** Validate the exact versioned report against independently reconstructed selected-result observations. */
export function assertPhase5Result(value: unknown, expected: Phase5Result): asserts value is Phase5Result {
  const report = strict(value, ['contract', 'version', 'kind', 'resultHash', 'metrics', 'warnings', 'reportHash']);
  if (report.contract !== PHASE5_RESULT_CONTRACT || report.version !== PHASE5_RESULT_VERSION)
    throw new Error('Unsupported MCNext Phase 5 result contract/version');
  const keys =
    report.kind === 'dependency-graph'
      ? [
          'nodes',
          'readyNodes',
          'blockedNodes',
          'dependencies',
          'resolvedDependencies',
          'blockedDependencies',
          'omittedDependencies',
          'cycles',
        ]
      : report.kind === 'deploy-preflight'
      ? [
          'routes',
          'readyRoutes',
          'blockedRoutes',
          'evaluatedOperations',
          'dependencies',
          'resolvedDependencies',
          'blockedDependencies',
          'omittedDependencies',
        ]
      : report.kind === 'portable-retrieval'
      ? [
          'cacheHits',
          'cacheMisses',
          'cacheRefreshes',
          'loaderCalls',
          ...((report.metrics as Record<string, unknown>)?.cacheMisses === 1
            ? ['evidenceCalls', 'evidenceItems', 'evidencePages']
            : []),
        ]
      : undefined;
  if (keys === undefined) throw new Error('Unsupported MCNext Phase 5 result kind');
  const metrics = strict(report.metrics, keys);
  const { reportHash, ...body } = report;
  if (reportHash !== hash(body) || typeof report.resultHash !== 'string' || !/^[a-f\d]{64}$/u.test(report.resultHash))
    throw new Error('Invalid MCNext Phase 5 report hash');
  for (const metric of Object.values(metrics)) count(metric);
  assertCounts(report.kind, metrics as Record<string, number>);
  if (
    !Array.isArray(report.warnings) ||
    report.warnings.some((warning) => typeof warning !== 'string' || !warning.trim())
  )
    throw new Error('Invalid MCNext Phase 5 warnings');
  if (hash(value) !== hash(expected)) throw new Error('MCNext Phase 5 result binding or metrics mismatch');
}

function assertCounts(kind: unknown, counts: Record<string, number>): void {
  if (kind === 'dependency-graph' && counts.nodes !== counts.readyNodes + counts.blockedNodes)
    throw new Error('Inconsistent graph node metrics');
  if (kind === 'deploy-preflight' && counts.routes !== counts.readyRoutes + counts.blockedRoutes)
    throw new Error('Inconsistent route metrics');
  if (
    kind !== 'portable-retrieval' &&
    counts.dependencies !== counts.resolvedDependencies + counts.blockedDependencies + counts.omittedDependencies
  )
    throw new Error('Inconsistent dependency metrics');
  if (
    kind === 'portable-retrieval' &&
    (counts.cacheHits + counts.cacheMisses !== 1 ||
      counts.cacheRefreshes !== counts.cacheMisses ||
      counts.loaderCalls !== counts.cacheMisses)
  )
    throw new Error('Inconsistent retrieval metrics');
}

function finalize(
  kind: Phase5Result['kind'],
  result: unknown,
  metrics: Record<string, number>,
  warnings: string[]
): Phase5Result {
  for (const value of Object.values(metrics)) count(value);
  const body = {
    contract: PHASE5_RESULT_CONTRACT,
    version: PHASE5_RESULT_VERSION,
    kind,
    resultHash: hash(result),
    metrics,
    warnings: [...new Set(warnings)].toSorted(),
  };
  return { ...body, reportHash: hash(body) };
}

function count(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid MCNext Phase 5 metric');
}

function strict(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join('\0') !== keys.toSorted().join('\0')
  )
    throw new Error('Unknown or missing MCNext Phase 5 result fields');
  return value as Record<string, unknown>;
}

function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sort(value)))
    .digest('hex');
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sort((value as Record<string, unknown>)[key])])
  );
}
