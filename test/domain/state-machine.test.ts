import { describe, it, expect } from "bun:test";
import { computeTransition } from "../../src/domain/state-machine.js";
import { parseWorkflowObject } from "../../src/domain/workflow.js";
import type { Job, WorkflowConfig } from "../../src/domain/types.js";

// ── テスト用ヘルパー ──

const BASIC_WF_OBJ = {
  plan: { type: "plan", agent: "developer", on: { completed: "execute", failed: "ABORT" } },
  execute: { type: "execute", agent: "developer", on: { completed: "review", failed: "plan" } },
  review: { type: "review", agent: "reviewer", on: { approved: "COMPLETE", rejected: "execute" } },
};

const AUTO_REVIEW_WF_OBJ = {
  plan: { type: "plan", agent: "developer", on: { completed: "execute", failed: "ABORT" } },
  execute: { type: "execute", agent: "developer", on: { completed: "review", failed: "plan" } },
  review: { type: "review", auto: true, agent: "reviewer", on: { approved: "COMPLETE", rejected: "execute" } },
};

function makeJob(overrides: Partial<Job["frontmatter"]> = {}): Job {
  const workflow = parseWorkflowObject(BASIC_WF_OBJ);
  return {
    frontmatter: {
      id: "J000001",
      title: "テスト",
      status: "running",
      current_phase: "plan",
      iteration: 0,
      max_iterations: 10,
      depends_on: [],
      acceptance_criteria: [],
      workflow,
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      ...overrides,
    },
    body: "",
  };
}

describe("computeTransition", () => {
  describe("continue", () => {
    it("plan completed → execute に continue する", () => {
      const job = makeJob({ current_phase: "plan", acceptance_criteria: [{ description: "基準1", done: false }] });
      const decision = computeTransition({ job, workflow: job.frontmatter.workflow, condition: "completed" });
      expect(decision.action).toBe("continue");
      if (decision.action === "continue") {
        expect(decision.nextPhase).toBe("execute");
        expect(decision.nextPhaseConfig.type).toBe("execute");
      }
    });

    it("execute failed → plan に continue する", () => {
      const job = makeJob({
        current_phase: "execute",
        acceptance_criteria: [{ description: "基準1", done: false }],
      });
      const decision = computeTransition({ job, workflow: job.frontmatter.workflow, condition: "failed" });
      expect(decision.action).toBe("continue");
      if (decision.action === "continue") {
        expect(decision.nextPhase).toBe("plan");
      }
    });

    it("auto review フェーズへの遷移は pause しない", () => {
      const wf = parseWorkflowObject(AUTO_REVIEW_WF_OBJ);
      const job = makeJob({ current_phase: "execute", workflow: wf });
      job.frontmatter.acceptance_criteria = [{ description: "基準1", done: false }];
      const decision = computeTransition({ job, workflow: wf, condition: "completed" });
      expect(decision.action).toBe("continue");
      if (decision.action === "continue") {
        expect(decision.nextPhase).toBe("review");
      }
    });

    it("iteration がインクリメントされる前提の遷移（continue を返す）", () => {
      const job = makeJob({ current_phase: "plan", iteration: 5, max_iterations: 10, acceptance_criteria: [{ description: "基準1", done: false }] });
      const decision = computeTransition({ job, workflow: job.frontmatter.workflow, condition: "completed" });
      expect(decision.action).toBe("continue");
    });
  });

  describe("complete (terminal)", () => {
    it("review approved → COMPLETE", () => {
      const job = makeJob({ current_phase: "review", status: "paused", pause_reason: "human_review" });
      const decision = computeTransition({ job, workflow: job.frontmatter.workflow, condition: "approved" });
      expect(decision.action).toBe("complete");
    });
  });

  describe("abort (terminal)", () => {
    it("plan failed → ABORT", () => {
      const job = makeJob({ current_phase: "plan" });
      const decision = computeTransition({ job, workflow: job.frontmatter.workflow, condition: "failed" });
      expect(decision.action).toBe("abort");
    });
  });

  describe("pause: human_review", () => {
    it("non-auto review フェーズへの遷移は human_review で pause する", () => {
      const job = makeJob({
        current_phase: "execute",
        acceptance_criteria: [{ description: "基準1", done: false }],
      });
      const decision = computeTransition({ job, workflow: job.frontmatter.workflow, condition: "completed" });
      expect(decision.action).toBe("pause");
      if (decision.action === "pause") {
        expect(decision.reason).toBe("human_review");
        expect(decision.nextPhase).toBe("review");
      }
    });
  });

  describe("pause: max_iterations", () => {
    it("iteration が max_iterations に達した場合に pause する", () => {
      const job = makeJob({
        current_phase: "plan",
        iteration: 10,
        max_iterations: 10,
        acceptance_criteria: [{ description: "基準1", done: false }],
      });
      const decision = computeTransition({ job, workflow: job.frontmatter.workflow, condition: "completed" });
      expect(decision.action).toBe("pause");
      if (decision.action === "pause") {
        expect(decision.reason).toBe("max_iterations");
        expect(decision.nextPhase).toBe("execute");
      }
    });

    it("iteration が max_iterations 未満なら pause しない", () => {
      const job = makeJob({
        current_phase: "plan",
        iteration: 9,
        max_iterations: 10,
        acceptance_criteria: [{ description: "基準1", done: false }],
      });
      const decision = computeTransition({ job, workflow: job.frontmatter.workflow, condition: "completed" });
      expect(decision.action).toBe("continue");
    });

    it("human_review は max_iterations より優先される", () => {
      const job = makeJob({
        current_phase: "execute",
        iteration: 10,
        max_iterations: 10,
        acceptance_criteria: [{ description: "基準1", done: false }],
      });
      const decision = computeTransition({ job, workflow: job.frontmatter.workflow, condition: "completed" });
      expect(decision.action).toBe("pause");
      if (decision.action === "pause") {
        expect(decision.reason).toBe("human_review");
      }
    });
  });

  describe("AC ガード", () => {
    it("execute フェーズへの遷移で AC なしの場合はエラー", () => {
      const job = makeJob({ current_phase: "plan", acceptance_criteria: [] });
      expect(() =>
        computeTransition({ job, workflow: job.frontmatter.workflow, condition: "completed" })
      ).toThrow("Acceptance Criteria が必要です");
    });

    it("execute フェーズへの遷移で AC ありの場合は通過する", () => {
      const job = makeJob({
        current_phase: "plan",
        acceptance_criteria: [{ description: "基準1", done: false }],
      });
      expect(() =>
        computeTransition({ job, workflow: job.frontmatter.workflow, condition: "completed" })
      ).not.toThrow();
    });
  });

  describe("エラーケース", () => {
    it("current_phase が未設定の場合はエラー", () => {
      const job = makeJob({ current_phase: undefined });
      expect(() =>
        computeTransition({ job, workflow: job.frontmatter.workflow, condition: "completed" })
      ).toThrow("現在のフェーズが設定されていません");
    });

    it("running/paused 以外のステータスはエラー", () => {
      const job = makeJob({ current_phase: "plan", status: "pending" });
      expect(() =>
        computeTransition({ job, workflow: job.frontmatter.workflow, condition: "completed" })
      ).toThrow("実行中ではありません");
    });

    it("ワークフローに存在しないフェーズ名はエラー", () => {
      const job = makeJob({ current_phase: "nonexistent" });
      expect(() =>
        computeTransition({ job, workflow: job.frontmatter.workflow, condition: "completed" })
      ).toThrow("フェーズ 'nonexistent' がワークフローに定義されていません");
    });

    it("review フェーズで completed を渡すとエラー", () => {
      const job = makeJob({ current_phase: "review", status: "paused", pause_reason: "human_review" });
      expect(() =>
        computeTransition({ job, workflow: job.frontmatter.workflow, condition: "completed" })
      ).toThrow("approved/rejected を使用してください");
    });

    it("plan フェーズで approved を渡すとエラー", () => {
      const job = makeJob({ current_phase: "plan" });
      expect(() =>
        computeTransition({ job, workflow: job.frontmatter.workflow, condition: "approved" })
      ).toThrow("completed/failed を使用してください");
    });
  });

  describe("paused 状態からの継続", () => {
    it("paused 状態でも遷移できる", () => {
      const job = makeJob({ current_phase: "review", status: "paused", pause_reason: "human_review" });
      const decision = computeTransition({ job, workflow: job.frontmatter.workflow, condition: "approved" });
      expect(decision.action).toBe("complete");
    });
  });
});
