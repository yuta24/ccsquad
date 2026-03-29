import { CcsquadError } from "../error.js";
import type { JobStatus } from "./types.js";

// ── Types ──

export interface DagNode {
  id: string;
  dependsOn: string[];
}

export interface DagResolution {
  /** Topological groups — nodes within the same group can run in parallel */
  groups: string[][];
  /** Flat topological order */
  order: string[];
}

// ── DAG resolution (Kahn's algorithm) ──

export function resolveDag(nodes: DagNode[]): DagResolution {
  const ids = new Set(nodes.map((n) => n.id));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) continue; // dependency outside the DAG (already completed)
      const targets = adjacency.get(dep) ?? [];
      targets.push(node.id);
      adjacency.set(dep, targets);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  const groups: string[][] = [];
  const order: string[] = [];
  let remaining = nodes.length;

  while (remaining > 0) {
    const group: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) {
        group.push(id);
      }
    }

    if (group.length === 0) {
      throw new CcsquadError("dag", "循環依存が検出されました");
    }

    group.sort(); // deterministic ordering
    groups.push(group);
    order.push(...group);

    for (const id of group) {
      inDegree.delete(id);
      for (const downstream of adjacency.get(id) ?? []) {
        inDegree.set(downstream, (inDegree.get(downstream) ?? 0) - 1);
      }
    }

    remaining -= group.length;
  }

  return { groups, order };
}

// ── Query helpers ──

export function isReadyToRun(
  jobId: string,
  nodes: DagNode[],
  statusMap: Map<string, JobStatus>,
): boolean {
  const node = nodes.find((n) => n.id === jobId);
  if (!node) return false;

  for (const dep of node.dependsOn) {
    if (statusMap.get(dep) !== "completed") return false;
  }
  return true;
}

export function collectDownstream(
  failedJobId: string,
  nodes: DagNode[],
): string[] {
  const downstream: string[] = [];
  const visited = new Set<string>([failedJobId]);
  const stack = [failedJobId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const node of nodes) {
      if (node.dependsOn.includes(current) && !visited.has(node.id)) {
        visited.add(node.id);
        downstream.push(node.id);
        stack.push(node.id);
      }
    }
  }

  return downstream;
}
