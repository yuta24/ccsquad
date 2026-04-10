import { describe, it, expect } from "bun:test";
import { analyzeMultipleJobs, formatOptimizationText, formatOptimizationJson } from "../src/domain/optimization.js";
import type { JobMetrics } from "../src/domain/metrics.js";

function makeMetrics(id: string, overrides?: Partial<JobMetrics>): JobMetrics {
  return {
    id,
    title: `ジョブ ${id}`,
    status: "completed",
    iteration: 3,
    maxIterations: 10,
    durationMs: 240 * 60 * 1000,
    rejectCount: 1,
    reviewTransitionCount: 2,
    acTotalCount: 0,
    acFulfilledCount: 0,
    phaseStats: [
      { phase: "plan", durationMs: 30 * 60 * 1000, transitions: { completed: 1 } },
      { phase: "execute", durationMs: 180 * 60 * 1000, transitions: { completed: 2, failed: 1 } },
      { phase: "review", durationMs: 30 * 60 * 1000, transitions: { approved: 1, rejected: 1 } },
    ],
    ...overrides,
  };
}

function wrap(m: JobMetrics) {
  return m;
}

// ─── analyzeMultipleJobs ─────────────────────────────────────────────────────

describe("analyzeMultipleJobs", () => {
  it("returns empty report for empty input", () => {
    const report = analyzeMultipleJobs([]);
    expect(report.jobCount).toBe(0);
    expect(report.aggregateStats).toEqual([]);
    expect(report.patterns).toEqual([]);
  });

  it("computes aggregate stats", () => {
    const m1 = makeMetrics("J000001");
    const m2 = makeMetrics("J000002");
    const report = analyzeMultipleJobs([wrap(m1), wrap(m2)]);

    expect(report.jobCount).toBe(2);
    expect(report.aggregateStats.length).toBe(3);

    const planStat = report.aggregateStats.find((s) => s.phase === "plan")!;
    expect(planStat.jobCount).toBe(2);
    expect(planStat.totalDurationMs).toBe(60 * 60 * 1000);
    expect(planStat.avgDurationMs).toBe(30 * 60 * 1000);
  });

  it("detects high reject rate across jobs (critical)", () => {
    const m1 = makeMetrics("J000001", { rejectCount: 3, reviewTransitionCount: 4 });
    const m2 = makeMetrics("J000002", { rejectCount: 4, reviewTransitionCount: 6 });
    const report = analyzeMultipleJobs([wrap(m1), wrap(m2)]);

    const pattern = report.patterns.find((p) => p.pattern === "high_reject_rate");
    expect(pattern).toBeDefined();
    expect(pattern!.severity).toBe("critical");
  });

  it("detects iteration overflow", () => {
    const m1 = makeMetrics("J000001", { iteration: 9, maxIterations: 10 });
    const m2 = makeMetrics("J000002", { iteration: 8, maxIterations: 10 });
    const m3 = makeMetrics("J000003", { iteration: 2, maxIterations: 10 });
    const report = analyzeMultipleJobs([wrap(m1), wrap(m2), wrap(m3)]);

    const pattern = report.patterns.find((p) => p.pattern === "iteration_overflow");
    expect(pattern).toBeDefined();
    expect(pattern!.affectedJobs).toContain("J000001");
    expect(pattern!.affectedJobs).toContain("J000002");
  });

  it("detects short plan high reject correlation", () => {
    const m1 = makeMetrics("J000001", {
      durationMs: 1000 * 60 * 1000,
      rejectCount: 3,
      reviewTransitionCount: 5,
      phaseStats: [
        { phase: "plan", durationMs: 5 * 60 * 1000, transitions: { completed: 1 } },
        { phase: "execute", durationMs: 900 * 60 * 1000, transitions: { completed: 2 } },
        { phase: "review", durationMs: 95 * 60 * 1000, transitions: { approved: 2, rejected: 3 } },
      ],
    });
    const report = analyzeMultipleJobs([wrap(m1)]);

    const pattern = report.patterns.find((p) => p.pattern === "short_plan_high_reject");
    expect(pattern).toBeDefined();
    expect(pattern!.affectedJobs).toContain("J000001");
  });

  it("no patterns for healthy jobs", () => {
    const m1 = makeMetrics("J000001", {
      rejectCount: 0,
      reviewTransitionCount: 1,
      iteration: 1,
      phaseStats: [
        { phase: "plan", durationMs: 30 * 60 * 1000, transitions: { completed: 1 } },
        { phase: "execute", durationMs: 30 * 60 * 1000, transitions: { completed: 1 } },
        { phase: "review", durationMs: 30 * 60 * 1000, transitions: { approved: 1 } },
      ],
    });
    const report = analyzeMultipleJobs([wrap(m1)]);

    expect(report.patterns).toEqual([]);
  });
});

// ─── formatOptimizationText ──────────────────────────────────────────────────

describe("formatOptimizationText", () => {
  it("contains header and stats", () => {
    const m1 = makeMetrics("J000001", { rejectCount: 3, reviewTransitionCount: 4 });
    const report = analyzeMultipleJobs([wrap(m1)]);
    const text = formatOptimizationText(report);

    expect(text).toContain("# ワークフロー最適化レポート");
    expect(text).toContain("対象ジョブ数: 1");
    expect(text).toContain("## フェーズ別集計");
  });

  it("shows no patterns message when healthy", () => {
    const m1 = makeMetrics("J000001", {
      rejectCount: 0,
      reviewTransitionCount: 1,
      iteration: 1,
      phaseStats: [
        { phase: "plan", durationMs: 30 * 60 * 1000, transitions: { completed: 1 } },
        { phase: "execute", durationMs: 30 * 60 * 1000, transitions: { completed: 1 } },
        { phase: "review", durationMs: 30 * 60 * 1000, transitions: { approved: 1 } },
      ],
    });
    const report = analyzeMultipleJobs([wrap(m1)]);
    const text = formatOptimizationText(report);

    expect(text).toContain("最適化の提案はありません");
  });
});

// ─── formatOptimizationJson ──────────────────────────────────────────────────

describe("formatOptimizationJson", () => {
  it("contains all expected fields", () => {
    const m1 = makeMetrics("J000001");
    const report = analyzeMultipleJobs([wrap(m1)]);
    const json = formatOptimizationJson(report);

    expect(json.created_at).toBeDefined();
    expect(json.job_count).toBe(1);
    expect(Array.isArray(json.aggregate_stats)).toBe(true);
    expect(Array.isArray(json.patterns)).toBe(true);
  });
});
