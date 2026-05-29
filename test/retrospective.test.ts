import { describe, it, expect } from "bun:test";
import { analyzeJob, formatRetrospectiveText, formatRetrospectiveJson } from "../src/domain/retrospective.js";
import type { Job, WorkflowConfig } from "../src/domain/types.js";
import type { JobMetrics } from "../src/domain/metrics.js";

const WORKFLOW: WorkflowConfig = {
  phases: [
    { name: "plan", type: "plan", agent: "planner", on: { completed: "execute", failed: "ABORT" } },
    { name: "execute", type: "execute", agent: "developer", on: { completed: "review", failed: "plan" } },
    { name: "review", type: "review", agent: "reviewer", on: { approved: "COMPLETE", rejected: "execute" } },
  ],
};

function makeJob(overrides?: Partial<{ status: string; iteration: number; maxIterations: number }>): Job {
  return {
    frontmatter: {
      id: "J000001",
      title: "テスト機能の実装",
      status: (overrides?.status as any) ?? "completed",
      iteration: overrides?.iteration ?? 3,
      max_iterations: overrides?.maxIterations ?? 10,
      priority: 0,
      depends_on: [],
      acceptance_criteria: [],
      workflow: WORKFLOW,
      created_at: "2026-03-24T09:00:00Z",
      updated_at: "2026-03-24T13:00:00Z",
    },
    body: "",
  };
}

function makeMetrics(overrides?: Partial<JobMetrics>): JobMetrics {
  return {
    id: "J000001",
    title: "テスト機能の実装",
    status: "completed",
    iteration: 3,
    maxIterations: 10,
    durationMs: 240 * 60 * 1000, // 4h
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

// ─── analyzeJob ──────────────────────────────────────────────────────────────

describe("analyzeJob", () => {
  it("returns report with correct job info", () => {
    const job = makeJob();
    const metrics = makeMetrics();
    const report = analyzeJob(job, metrics);

    expect(report.jobId).toBe("J000001");
    expect(report.jobTitle).toBe("テスト機能の実装");
    expect(report.jobStatus).toBe("completed");
    expect(report.metrics).toBe(metrics);
  });

  it("detects high reject rate (critical)", () => {
    const job = makeJob();
    const metrics = makeMetrics({ rejectCount: 3, reviewTransitionCount: 4 });
    const report = analyzeJob(job, metrics);

    const finding = report.findings.find((f) => f.category === "high_reject_rate");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
    expect(finding!.description).toContain("75%");
  });

  it("detects high reject rate (warning)", () => {
    const job = makeJob();
    const metrics = makeMetrics({ rejectCount: 2, reviewTransitionCount: 5 });
    const report = analyzeJob(job, metrics);

    const finding = report.findings.find((f) => f.category === "high_reject_rate");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("does not detect high reject rate when rate is low", () => {
    const job = makeJob();
    const metrics = makeMetrics({ rejectCount: 0, reviewTransitionCount: 3 });
    const report = analyzeJob(job, metrics);

    const finding = report.findings.find((f) => f.category === "high_reject_rate");
    expect(finding).toBeUndefined();
  });

  it("detects iteration overflow (critical)", () => {
    const job = makeJob({ iteration: 10, maxIterations: 10 });
    const metrics = makeMetrics({ iteration: 10, maxIterations: 10 });
    const report = analyzeJob(job, metrics);

    const finding = report.findings.find((f) => f.category === "iteration_overflow");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
  });

  it("detects iteration overflow (warning at 80%)", () => {
    const job = makeJob({ iteration: 8, maxIterations: 10 });
    const metrics = makeMetrics({ iteration: 8, maxIterations: 10 });
    const report = analyzeJob(job, metrics);

    const finding = report.findings.find((f) => f.category === "iteration_overflow");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("detects plan insufficient when plan ratio is low and rejects exist", () => {
    const job = makeJob();
    const metrics = makeMetrics({
      durationMs: 1000 * 60 * 1000,
      rejectCount: 2,
      reviewTransitionCount: 3,
      phaseStats: [
        { phase: "plan", durationMs: 5 * 60 * 1000, transitions: { completed: 1 } },
        { phase: "execute", durationMs: 900 * 60 * 1000, transitions: { completed: 2 } },
        { phase: "review", durationMs: 95 * 60 * 1000, transitions: { approved: 1, rejected: 2 } },
      ],
    });
    const report = analyzeJob(job, metrics);

    const finding = report.findings.find((f) => f.category === "plan_insufficient");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("detects long phase", () => {
    const job = makeJob();
    const metrics = makeMetrics({
      durationMs: 100 * 60 * 1000,
      phaseStats: [
        { phase: "plan", durationMs: 5 * 60 * 1000, transitions: { completed: 1 } },
        { phase: "execute", durationMs: 90 * 60 * 1000, transitions: { completed: 1 } },
        { phase: "review", durationMs: 5 * 60 * 1000, transitions: { approved: 1 } },
      ],
    });
    const report = analyzeJob(job, metrics);

    const finding = report.findings.find((f) => f.category === "long_phase");
    expect(finding).toBeDefined();
    expect(finding!.phase).toBe("execute");
  });

  it("detects fast completion", () => {
    const job = makeJob({ iteration: 1 });
    const metrics = makeMetrics({ iteration: 1, rejectCount: 0, reviewTransitionCount: 1 });
    const report = analyzeJob(job, metrics);

    const finding = report.findings.find((f) => f.category === "fast_completion");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
  });

  it("generates summary", () => {
    const job = makeJob();
    const metrics = makeMetrics();
    const report = analyzeJob(job, metrics);

    expect(report.summary).toContain("J000001");
    expect(report.summary).toContain("completed");
  });
});

// ─── formatRetrospectiveText ─────────────────────────────────────────────────

describe("formatRetrospectiveText", () => {
  it("contains all expected sections", () => {
    const job = makeJob();
    const metrics = makeMetrics({ rejectCount: 3, reviewTransitionCount: 4 });
    const report = analyzeJob(job, metrics);
    const text = formatRetrospectiveText(report);

    expect(text).toContain("# 振り返り: J000001");
    expect(text).toContain("## サマリー");
    expect(text).toContain("## 検出事項");
    expect(text).toContain("[CRITICAL]");
  });

  it("shows no findings message when none", () => {
    const job = makeJob({ iteration: 1 });
    const metrics = makeMetrics({
      iteration: 1,
      rejectCount: 0,
      reviewTransitionCount: 1,
      phaseStats: [
        { phase: "plan", durationMs: 30 * 60 * 1000, transitions: { completed: 1 } },
        { phase: "execute", durationMs: 30 * 60 * 1000, transitions: { completed: 1 } },
        { phase: "review", durationMs: 30 * 60 * 1000, transitions: { approved: 1 } },
      ],
    });
    const report = analyzeJob(job, metrics);
    const text = formatRetrospectiveText(report);
    expect(text).toContain("[INFO]");
  });
});

// ─── formatRetrospectiveJson ─────────────────────────────────────────────────

describe("formatRetrospectiveJson", () => {
  it("contains all expected fields", () => {
    const job = makeJob();
    const metrics = makeMetrics();
    const report = analyzeJob(job, metrics);
    const json = formatRetrospectiveJson(report);

    expect(json.job_id).toBe("J000001");
    expect(json.job_title).toBe("テスト機能の実装");
    expect(json.job_status).toBe("completed");
    expect(json.summary).toBeDefined();
    expect(Array.isArray(json.findings)).toBe(true);
    expect(json.metrics).toBeDefined();
  });
});

// ─── low_ac_fulfillment ─────────────────────────────────────────────────────

describe("analyzeJob - low_ac_fulfillment", () => {
  it("完了ジョブで AC 充足率が低い場合に検出する", () => {
    const job = makeJob();
    const metrics = makeMetrics({ acTotalCount: 5, acFulfilledCount: 3 });
    const report = analyzeJob(job, metrics);

    const finding = report.findings.find((f) => f.category === "low_ac_fulfillment");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.description).toContain("60%");
  });

  it("AC 充足率が 80% 以上なら検出しない", () => {
    const job = makeJob();
    const metrics = makeMetrics({ acTotalCount: 5, acFulfilledCount: 4 });
    const report = analyzeJob(job, metrics);

    const finding = report.findings.find((f) => f.category === "low_ac_fulfillment");
    expect(finding).toBeUndefined();
  });

  it("AC がないジョブでは検出しない", () => {
    const job = makeJob();
    const metrics = makeMetrics({ acTotalCount: 0, acFulfilledCount: 0 });
    const report = analyzeJob(job, metrics);

    const finding = report.findings.find((f) => f.category === "low_ac_fulfillment");
    expect(finding).toBeUndefined();
  });

  it("失敗ジョブで部分達成がある場合 info で検出する", () => {
    const job = makeJob({ status: "failed" });
    const metrics = makeMetrics({ status: "failed", acTotalCount: 3, acFulfilledCount: 1 });
    const report = analyzeJob(job, metrics);

    const finding = report.findings.find((f) => f.category === "low_ac_fulfillment");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
  });
});
