import type { PipelineGraph } from "../types";

const LOOP_AGENT_ID = "loop";

function buildLoopNodeIdSet(graph: PipelineGraph): Set<string> {
  return new Set(
    graph.nodes
      .filter((node) => node.agentId === LOOP_AGENT_ID)
      .map((node) => node.id),
  );
}

function isLoopbackEdge(edge: { source: string }, loopNodeIds: Set<string>): boolean {
  return loopNodeIds.has(edge.source);
}

export function validateDag(graph: PipelineGraph): void {
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error("Invalid graph format");
  }

  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  if (nodeIds.size !== graph.nodes.length) {
    throw new Error("Graph nodes must have unique ids");
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(`Edge ${edge.id} points to unknown node`);
    }
  }

  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  const loopNodeIds = buildLoopNodeIdSet(graph);
  for (const edge of graph.edges) {
    if (isLoopbackEdge(edge, loopNodeIds)) {
      continue;
    }
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    adjacency.get(edge.source)?.push(edge.target);
  }

  const startNodes = [...inDegree.entries()].filter(([, degree]) => degree === 0);
  if (startNodes.length === 0) {
    throw new Error("Graph must contain at least one start node");
  }

  const queue: string[] = startNodes.map(([id]) => id);
  let visited = 0;

  while (queue.length > 0) {
    const current = queue.shift() as string;
    visited += 1;

    for (const next of adjacency.get(current) ?? []) {
      inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
      if (inDegree.get(next) === 0) {
        queue.push(next);
      }
    }
  }

  if (visited !== graph.nodes.length) {
    throw new Error("Graph contains cycle(s)");
  }
}

export function topologicalSort(graph: PipelineGraph): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of graph.nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  const loopNodeIds = buildLoopNodeIdSet(graph);
  for (const edge of graph.edges) {
    if (isLoopbackEdge(edge, loopNodeIds)) {
      continue;
    }
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    adjacency.get(edge.source)?.push(edge.target);
  }

  const queue: string[] = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);

  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    result.push(current);

    for (const next of adjacency.get(current) ?? []) {
      inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
      if (inDegree.get(next) === 0) {
        queue.push(next);
      }
    }
  }

  if (result.length !== graph.nodes.length) {
    throw new Error("Cannot topologically sort cyclic graph");
  }

  return result;
}

export function collectPredecessors(graph: PipelineGraph, nodeId: string): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const node of graph.nodes) {
    reverse.set(node.id, []);
  }
  const loopNodeIds = buildLoopNodeIdSet(graph);
  for (const edge of graph.edges) {
    if (isLoopbackEdge(edge, loopNodeIds)) {
      continue;
    }
    reverse.get(edge.target)?.push(edge.source);
  }

  const seen = new Set<string>();
  const stack = [...(reverse.get(nodeId) ?? [])];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const prev of reverse.get(current) ?? []) {
      if (!seen.has(prev)) {
        stack.push(prev);
      }
    }
  }

  return seen;
}
