import { describe, it, expect, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePhaseLog } from "../src/domain/phase-log.js";
import type { PhaseLogEntry } from "../src/domain/phase-log.js";
import { computeMetrics, formatDuration, formatMetricsText, formatMetricsJson } from "../src/domain/metrics.js";
import type { Job, WorkflowConfig } from "../src/domain/types.js";
import { cmdSummary } from "../src/cli/commands/job.js";
import { JobStore } from "../src/infra/job-store.js";
import type { ProjectContext } from "../src/app/project-context.js";
import { createTestContext } from "./helpers.js";

const WORKFLOW: WorkflowConfig = {
  phases: [
    { name: "research", type: "plan", agent: "planner", on: { completed: "design", failed: "ABORT" } },
    { name: "design", type: "plan", agent: "planner", on: { completed: "code" } },
    { name: "code", type: "execute", agent: "developer", on: { completed: "review", failed: "design" } },
    { name: "review", type: "review", agent: "reviewer", on: { approved: "COMPLETE", rejected: "code" } },
  ],
};

const PHASE_LOG = `## フェーズログ
### research (completed → design) - 2026-03-24T09:30:00Z
調査完了。
### design (completed → code) - 2026-03-24T10:00:00Z
設計完了。
### code (failed → design) - 2026-03-24T10:45:00Z
型エラーが発生。
### design (completed → code) - 2026-03-24T11:00:00Z
再設計完了。
### code (completed → review) - 2026-03-24T12:00:00Z
実装完了。
### review (rejected → code) - 2026-03-24T12:15:00Z
テストが不足。
### code (completed → review) - 2026-03-24T13:00:00Z
テスト追加。
### review (approved → COMPLETE) - 2026-03-24T13:10:00Z
LGTM。
`;

function makeJobWithLog(overrides?: Partial<{ status: string; body: string }>): Job {
  return {
    frontmatter: {
      id: "J000001",
      title: "認証機能の実装",
      status: (overrides?.status as any) ?? "completed",
      iteration: 5,
      max_iterations: 10,
      priority: 0,
      depends_on: [],
      workflow: WORKFLOW,
      created_at: "2026-03-24T09:00:00Z",
      updated_at: "2026-03-24T13:10:00Z",
    },
    body: overrides?.body ?? PHASE_LOG,
  };
}

// ─── parsePhaseLog ──────────────────────────────────────────────────────────

describe("parsePhaseLog", () => {
  it("parses all entries from phase log", () => {
    const entries = parsePhaseLog(PHASE_LOG);
    expect(entries).toHaveLength(8);
    expect(entries[0]).toEqual({
      phase: "research",
      result: "completed",
      next: "design",
      timestamp: "2026-03-24T09:30:00Z",
    });
    expect(entries[7]).toEqual({
      phase: "review",
      result: "approved",
      next: "COMPLETE",
      timestamp: "2026-03-24T13:10:00Z",
    });
  });

  it("returns empty array when no phase log section", () => {
    const entries = parsePhaseLog("some body content");
    expect(entries).toEqual([]);
  });

  it("returns empty array for empty body", () => {
    const entries = parsePhaseLog("");
    expect(entries).toEqual([]);
  });

  it("parses entries with various result types", () => {
    const entries = parsePhaseLog(PHASE_LOG);
    const results = entries.map((e) => e.result);
    expect(results).toContain("completed");
    expect(results).toContain("failed");
    expect(results).toContain("rejected");
    expect(results).toContain("approved");
  });
});

// ─── computeMetrics ─────────────────────────────────────────────────────────

describe("computeMetrics", () => {
  it("returns null when no phase log entries", () => {
    const job = makeJobWithLog({ body: "" });
    const metrics = computeMetrics(job);
    expect(metrics).toBeNull();
  });

  it("computes basic job info", () => {
    const job = makeJobWithLog();
    const metrics = computeMetrics(job)!;
    expect(metrics.id).toBe("J000001");
    expect(metrics.title).toBe("認証機能の実装");
    expect(metrics.status).toBe("completed");
    expect(metrics.iteration).toBe(5);
    expect(metrics.maxIterations).toBe(10);
  });

  it("computes duration from created_at to updated_at", () => {
    const job = makeJobWithLog();
    const metrics = computeMetrics(job)!;
    // 09:00 to 13:10 = 4h 10m = 250 minutes
    expect(metrics.durationMs).toBe(250 * 60 * 1000);
  });

  it("computes reject rate", () => {
    const job = makeJobWithLog();
    const metrics = computeMetrics(job)!;
    // 1 rejected, 1 approved = 2 review transitions
    expect(metrics.rejectCount).toBe(1);
    expect(metrics.reviewTransitionCount).toBe(2);
  });

  it("computes phase stats with correct phases", () => {
    const job = makeJobWithLog();
    const metrics = computeMetrics(job)!;
    const phaseNames = metrics.phaseStats.map((ps) => ps.phase);
    expect(phaseNames).toEqual(["research", "design", "code", "review"]);
  });

  it("computes phase transition counts", () => {
    const job = makeJobWithLog();
    const metrics = computeMetrics(job)!;

    const research = metrics.phaseStats.find((p) => p.phase === "research")!;
    expect(research.transitions).toEqual({ completed: 1 });

    const design = metrics.phaseStats.find((p) => p.phase === "design")!;
    expect(design.transitions).toEqual({ completed: 2 });

    const code = metrics.phaseStats.find((p) => p.phase === "code")!;
    expect(code.transitions).toEqual({ completed: 2, failed: 1 });

    const review = metrics.phaseStats.find((p) => p.phase === "review")!;
    expect(review.transitions).toEqual({ rejected: 1, approved: 1 });
  });

  it("computes phase durations", () => {
    const job = makeJobWithLog();
    const metrics = computeMetrics(job)!;

    // research: 09:00 -> 09:30 = 30m
    const research = metrics.phaseStats.find((p) => p.phase === "research")!;
    expect(research.durationMs).toBe(30 * 60 * 1000);

    // design: (09:30->10:00) + (10:45->11:00) = 30m + 15m = 45m
    const design = metrics.phaseStats.find((p) => p.phase === "design")!;
    expect(design.durationMs).toBe(45 * 60 * 1000);

    // code: (10:00->10:45) + (11:00->12:00) + (12:15->13:00) = 45m + 60m + 45m = 150m
    const code = metrics.phaseStats.find((p) => p.phase === "code")!;
    expect(code.durationMs).toBe(150 * 60 * 1000);

    // review: (12:00->12:15) + (13:00->13:10) = 15m + 10m = 25m
    const review = metrics.phaseStats.find((p) => p.phase === "review")!;
    expect(review.durationMs).toBe(25 * 60 * 1000);
  });
});

// ─── formatDuration ─────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("formats minutes only", () => {
    expect(formatDuration(45 * 60 * 1000)).toBe("45m");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(154 * 60 * 1000)).toBe("2h 34m");
  });

  it("formats zero", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  it("formats negative as 0m", () => {
    expect(formatDuration(-1000)).toBe("0m");
  });

  it("formats exact hours", () => {
    expect(formatDuration(120 * 60 * 1000)).toBe("2h 0m");
  });
});

// ─── formatMetricsText ──────────────────────────────────────────────────────

describe("formatMetricsText", () => {
  it("contains all expected sections", () => {
    const job = makeJobWithLog();
    const metrics = computeMetrics(job)!;
    const text = formatMetricsText(metrics);

    expect(text).toContain("ジョブ: J000001 - 認証機能の実装");
    expect(text).toContain("ステータス: completed");
    expect(text).toContain("総イテレーション: 5 / 10");
    expect(text).toContain("所要時間:");
    expect(text).toContain("reject 率: 1/2 (50%)");
    expect(text).toContain("フェーズ別:");
    expect(text).toContain("research");
    expect(text).toContain("design");
    expect(text).toContain("code");
    expect(text).toContain("review");
  });
});

// ─── formatMetricsJson ──────────────────────────────────────────────────────

describe("formatMetricsJson", () => {
  it("contains all expected fields", () => {
    const job = makeJobWithLog();
    const metrics = computeMetrics(job)!;
    const json = formatMetricsJson(metrics);

    expect(json.id).toBe("J000001");
    expect(json.title).toBe("認証機能の実装");
    expect(json.status).toBe("completed");
    expect(json.iteration).toBe(5);
    expect(json.max_iterations).toBe(10);
    expect(json.duration_ms).toBe(250 * 60 * 1000);
    expect(json.reject_count).toBe(1);
    expect(json.review_transition_count).toBe(2);
    expect(json.reject_rate).toBe(0.5);
    expect(json.phases).toHaveLength(4);
  });
});

// ─── cmdSummary ─────────────────────────────────────────────────────────────

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

function setup(): { ctx: ProjectContext } {
  return { ctx: createTestContext("ccsquad-metrics-") };
}

describe("cmdSummary", () => {
  it("displays text summary for job with phase log", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJobWithLog());
    const lines = captureLog(() => cmdSummary(ctx, "J000001", "text"));
    const output = lines.join("\n");
    expect(output).toContain("ジョブ: J000001");
    expect(output).toContain("ステータス: completed");
    expect(output).toContain("フェーズ別:");
  });

  it("displays json summary for job with phase log", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJobWithLog());
    const lines = captureLog(() => cmdSummary(ctx, "J000001", "json"));
    const json = JSON.parse(lines.join("\n"));
    expect(json.id).toBe("J000001");
    expect(json.reject_count).toBe(1);
    expect(json.phases).toHaveLength(4);
  });

  it("shows message when no phase log (text)", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJobWithLog({ body: "" }));
    const lines = captureLog(() => cmdSummary(ctx, "J000001", "text"));
    const output = lines.join("\n");
    expect(output).toContain("フェーズログがありません");
  });

  it("shows error in json when no phase log", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJobWithLog({ body: "" }));
    const lines = captureLog(() => cmdSummary(ctx, "J000001", "json"));
    const json = JSON.parse(lines.join("\n"));
    expect(json.error).toBe("フェーズログがありません");
  });

  it("throws for nonexistent job", () => {
    const { ctx } = setup();
    expect(() => cmdSummary(ctx, "J999999", "text")).toThrow();
  });
});
