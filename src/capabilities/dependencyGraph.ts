import {
  assertDependencyDescriptor,
  assertPortableIdentity,
  type DependencyDescriptor,
  type PortableIdentity,
} from './contracts.js';

export type DependencyGraphNodeInput = {
  portableIdentity: PortableIdentity;
  blockedReasons: string[];
  dependencies: DependencyGraphEdgeInput[];
};
export type DependencyGraphEdgeInput = {
  descriptor: DependencyDescriptor;
  resolution:
    | { kind: 'package' }
    | { kind: 'target' }
    | { kind: 'unresolved'; reason: string }
    | { kind: 'omitted'; semanticsEvidence: string };
};
export type DependencyGraphNode = {
  key: string;
  portableIdentity: PortableIdentity;
  ready: boolean;
  blockedReasons: string[];
};
export type DependencyGraphEdge = DependencyGraphEdgeInput & { sourceKey: string; targetKey: string };
export type DependencyGraphPlan = {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  layers: string[][];
  cycles: string[][];
  components: string[][];
};

/** Exact portable identity key, retaining namespace and every provider-native context field. */
export function portableIdentityKey(identity: PortableIdentity): string {
  assertPortableIdentity(identity);
  return canonical(identity);
}

/** Plan a detached deterministic graph; only evidenced optional omissions remove dependency constraints. */
export function planDependencyGraph(input: DependencyGraphNodeInput[]): DependencyGraphPlan {
  const nodes = new Map<string, DependencyGraphNode>();
  for (const item of input) {
    const key = portableIdentityKey(item.portableIdentity);
    if (nodes.has(key))
      throw new Error(`Duplicate or conflicting portable identity (ambiguous package dependency): ${key}`);
    nodes.set(key, {
      key,
      portableIdentity: structuredClone(item.portableIdentity),
      ready: false,
      blockedReasons: [...new Set(item.blockedReasons)].sort(),
    });
  }
  const keys = [...nodes.keys()].sort();
  const edges: DependencyGraphEdge[] = [];
  const adjacency = new Map(keys.map((key) => [key, new Set<string>()]));
  for (const item of input) {
    const sourceKey = portableIdentityKey(item.portableIdentity);
    for (const dependency of item.dependencies) {
      assertDependencyDescriptor(dependency.descriptor);
      if (portableIdentityKey(dependency.descriptor.source) !== sourceKey)
        throw new Error('Dependency source does not match owning operation identity');
      const targetKey = portableIdentityKey(dependency.descriptor.target);
      const edge = structuredClone({ ...dependency, sourceKey, targetKey });
      edges.push(edge);
      if (edge.resolution.kind === 'omitted') {
        if (edge.descriptor.required || !edge.resolution.semanticsEvidence.trim())
          throw new Error('Only semantics-evidenced optional references may be omitted');
      } else if (edge.resolution.kind === 'package') {
        if (!nodes.has(targetKey)) throw new Error(`Package graph target is absent: ${targetKey}`);
        adjacency.get(sourceKey)!.add(targetKey);
      } else if (edge.resolution.kind === 'unresolved') {
        nodes
          .get(sourceKey)!
          .blockedReasons.push(
            `Unresolved dependency ${edge.descriptor.kind} -> ${targetKey}: ${edge.resolution.reason}`
          );
      }
    }
  }
  edges.sort((left, right) => compare(canonical(left), canonical(right)));
  const neighbors = (key: string): string[] => [...adjacency.get(key)!].sort();
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const active: string[] = [];
  const visit = (key: string): void => {
    const position = active.indexOf(key);
    if (position !== -1) {
      const path = [...active.slice(position), key];
      cycles.push(path);
      for (const member of path) nodes.get(member)!.blockedReasons.push(`Dependency cycle: ${path.join(' -> ')}`);
      return;
    }
    if (visited.has(key)) return;
    active.push(key);
    for (const next of neighbors(key)) visit(next);
    active.pop();
    visited.add(key);
  };
  for (const key of keys) visit(key);
  const inherited = new Map<string, string[]>();
  // Propagate concrete local failures along each dependency closure, without recursively expanding messages.
  for (const key of keys) {
    const reached = new Set<string>([key]);
    const pending = neighbors(key);
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (reached.has(next)) continue;
      reached.add(next);
      pending.push(...neighbors(next));
    }
    const reasons = [...reached]
      .sort()
      .flatMap((member) =>
        member === key
          ? []
          : nodes.get(member)!.blockedReasons.map((reason) => `Blocked dependency ${member}: ${reason}`)
      );
    // Keep propagation separate until every closure has been inspected.
    inherited.set(key, reasons);
  }
  function finalizeNodes(): void {
    for (const key of keys) {
      const node = nodes.get(key)!;
      node.blockedReasons = [...new Set([...node.blockedReasons, ...inherited.get(key)!])].sort();
      node.ready = node.blockedReasons.length === 0;
    }
  }
  finalizeNodes();
  const remaining = new Set(keys.filter((key) => nodes.get(key)!.ready));
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const layer = [...remaining].filter((key) => neighbors(key).every((next) => !remaining.has(next))).sort();
    if (layer.length === 0) throw new Error('Unblocked graph contains a dependency cycle');
    layers.push(layer);
    for (const key of layer) remaining.delete(key);
  }
  const components = disconnectedComponents(keys, neighbors);
  return {
    nodes: keys.map((key) => nodes.get(key)!),
    edges,
    layers,
    cycles: cycles.sort((left, right) => compare(canonical(left), canonical(right))),
    components,
  };
}

function disconnectedComponents(keys: string[], neighbors: (key: string) => string[]): string[][] {
  const undirected = new Map(keys.map((key) => [key, new Set(neighbors(key))]));
  for (const key of keys) for (const next of neighbors(key)) undirected.get(next)!.add(key);
  const unseen = new Set(keys);
  const components: string[][] = [];
  for (const key of keys) {
    if (!unseen.has(key)) continue;
    const component: string[] = [];
    const pending = [key];
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (!unseen.delete(next)) continue;
      component.push(next);
      pending.push(...undirected.get(next)!);
    }
    components.push(component.sort());
  }
  return components;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson((value as Record<string, unknown>)[key])])
  );
}
