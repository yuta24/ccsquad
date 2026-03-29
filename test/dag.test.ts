import { describe, it, expect } from "bun:test";
import { resolveDag, isReadyToRun, collectDownstream } from "../src/domain/dag.js";
import type { DagNode } from "../src/domain/dag.js";
import type { JobStatus } from "../src/domain/types.js";

describe("resolveDag", () => {
  it("linear chain: A→B→C", () => {
    const nodes: DagNode[] = [
      { id: "J001", dependsOn: [] },
      { id: "J002", dependsOn: ["J001"] },
      { id: "J003", dependsOn: ["J002"] },
    ];
    const { groups, order } = resolveDag(nodes);
    expect(groups).toEqual([["J001"], ["J002"], ["J003"]]);
    expect(order).toEqual(["J001", "J002", "J003"]);
  });

  it("parallel group: B,C depend on A", () => {
    const nodes: DagNode[] = [
      { id: "J001", dependsOn: [] },
      { id: "J002", dependsOn: ["J001"] },
      { id: "J003", dependsOn: ["J001"] },
    ];
    const { groups } = resolveDag(nodes);
    expect(groups).toEqual([["J001"], ["J002", "J003"]]);
  });

  it("fully independent jobs", () => {
    const nodes: DagNode[] = [
      { id: "J001", dependsOn: [] },
      { id: "J002", dependsOn: [] },
      { id: "J003", dependsOn: [] },
    ];
    const { groups } = resolveDag(nodes);
    expect(groups).toEqual([["J001", "J002", "J003"]]);
  });

  it("diamond dependency: D depends on B,C which depend on A", () => {
    const nodes: DagNode[] = [
      { id: "J001", dependsOn: [] },
      { id: "J002", dependsOn: ["J001"] },
      { id: "J003", dependsOn: ["J001"] },
      { id: "J004", dependsOn: ["J002", "J003"] },
    ];
    const { groups } = resolveDag(nodes);
    expect(groups).toEqual([["J001"], ["J002", "J003"], ["J004"]]);
  });

  it("detects circular dependency", () => {
    const nodes: DagNode[] = [
      { id: "J001", dependsOn: ["J002"] },
      { id: "J002", dependsOn: ["J001"] },
    ];
    expect(() => resolveDag(nodes)).toThrow("循環依存");
  });

  it("ignores dependencies outside the DAG", () => {
    const nodes: DagNode[] = [
      { id: "J002", dependsOn: ["J001"] }, // J001 is not in the node list
    ];
    const { groups } = resolveDag(nodes);
    expect(groups).toEqual([["J002"]]);
  });
});

describe("isReadyToRun", () => {
  const nodes: DagNode[] = [
    { id: "J001", dependsOn: [] },
    { id: "J002", dependsOn: ["J001"] },
    { id: "J003", dependsOn: ["J001", "J002"] },
  ];

  it("returns true when all dependencies completed", () => {
    const statusMap = new Map<string, JobStatus>([
      ["J001", "completed"],
      ["J002", "pending"],
      ["J003", "pending"],
    ]);
    expect(isReadyToRun("J001", nodes, statusMap)).toBe(true);
    expect(isReadyToRun("J002", nodes, statusMap)).toBe(true);
    expect(isReadyToRun("J003", nodes, statusMap)).toBe(false);
  });

  it("returns false when dependency is not completed", () => {
    const statusMap = new Map<string, JobStatus>([
      ["J001", "running"],
      ["J002", "pending"],
    ]);
    expect(isReadyToRun("J002", nodes, statusMap)).toBe(false);
  });

  it("returns false for unknown jobId", () => {
    const statusMap = new Map<string, JobStatus>();
    expect(isReadyToRun("J999", nodes, statusMap)).toBe(false);
  });
});

describe("collectDownstream", () => {
  const nodes: DagNode[] = [
    { id: "J001", dependsOn: [] },
    { id: "J002", dependsOn: ["J001"] },
    { id: "J003", dependsOn: ["J001"] },
    { id: "J004", dependsOn: ["J002"] },
    { id: "J005", dependsOn: [] },
  ];

  it("collects all transitive downstream nodes", () => {
    const downstream = collectDownstream("J001", nodes);
    expect(downstream.sort()).toEqual(["J002", "J003", "J004"]);
  });

  it("does not include unrelated nodes", () => {
    const downstream = collectDownstream("J001", nodes);
    expect(downstream).not.toContain("J005");
  });

  it("returns empty for leaf node", () => {
    const downstream = collectDownstream("J004", nodes);
    expect(downstream).toEqual([]);
  });
});
