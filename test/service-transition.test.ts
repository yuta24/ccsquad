import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndExecuteTransition, validateConditionForPhase } from "../src/service/transition.js";
import { JobStore } from "../src/job.js";
import type { Job, JobStatus } from "../src/job.js";
import { IterationStore } from "../src/iteration.js";
import { SquadConfigImpl } from "../src/config.js";
import { WorkflowEngine } from "../src/engine.js";

// ─── テスト用設定 ─────────────────────────────────────────────────────────────
// dev ワークフロー: plan → code → review(human) → COMPLETE

const CONFIG_YAML = `
workflows:
  dev:
    max_iterations: 3
    phases:
      - name: plan
        type: task
        description: 計画
        agent: planner
        on:
          completed: code
          failed: ABORT
      - name: code
        type: task
        description: 実装
        agent: coder
        on:
          completed: review
          failed: plan
      - name: review
        type: review
        description: レビュー
        reviewer: human
        on:
          approved: COMPLETE
          rejected: code
`;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ccsquad-svc-transition-"));
}

function makeJob(id: string, status: JobStatus, workflow = "dev"): Job {
  const now = new Date().toISOString();
  return {
    frontmatter: {
      id,
      title: "テスト",
      workflow,
      status,
      priority: 0,
      depends_on: [],
      created_at: now,
      updated_at: now,
    },
    body: "",
  };
}

function setup(workflow = "dev") {
  const dir = makeTmpDir();
  const store = new JobStore(dir);
  store.ensureDir();
  const config = SquadConfigImpl.parse(CONFIG_YAML);
  const iterationStore = new IterationStore(dir);
  const wf = config.getWorkflow(workflow)!;
  const engine = new WorkflowEngine(wf, store);

  const job = makeJob("J000001", "pending", workflow);
  store.save(job);
  engine.startJob("J000001");

  return { dir, store, config, iterationStore, engine, wf };
}

// ─── resolveAndExecuteTransition - 終端遷移 ───────────────────────────────────

describe("resolveAndExecuteTransition - 終端遷移 (COMPLETE)", () => {
  it("test_complete_transition_returns_done_with_completed_status", () => {
    const { store, wf, iterationStore } = setup();
    // plan → completed → code → completed → review → approved → COMPLETE
    const engine = new WorkflowEngine(wf, store);
    engine.transition("J000001", "completed", "");
    engine.transition("J000001", "completed", "");
    // now at review (reviewer phase)

    const result = resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "approved", "LGTM");

    expect(result.type).toBe("done");
    expect(result.jobId).toBe("J000001");
    if (result.type === "done") {
      expect(result.status).toBe("completed");
    }
  });

  it("test_abort_transition_returns_done_with_failed_status", () => {
    const { store, wf, iterationStore } = setup();
    // plan → failed → ABORT

    const result = resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "failed", "致命的エラー");

    expect(result.type).toBe("done");
    expect(result.jobId).toBe("J000001");
    if (result.type === "done") {
      expect(result.status).toBe("failed");
    }
  });

  it("test_terminal_transition_removes_iteration", () => {
    const { store, wf, iterationStore } = setup();
    const engine = new WorkflowEngine(wf, store);
    engine.transition("J000001", "completed", "");
    engine.transition("J000001", "completed", "");
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");
    expect(iterationStore.get("J000001")).toBe(2);

    resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "approved", "");

    expect(iterationStore.get("J000001")).toBe(0);
  });
});

// ─── resolveAndExecuteTransition - max_iterations ─────────────────────────────

describe("resolveAndExecuteTransition - max_iterations", () => {
  it("test_max_iterations_reached_returns_pause_with_reason_max_iterations", () => {
    const { store, wf, iterationStore } = setup();
    // max_iterations = 3、3回目でブロック
    iterationStore.increment("J000001"); // 1
    iterationStore.increment("J000001"); // 2
    iterationStore.increment("J000001"); // 3 = max

    const result = resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", "計画完了");

    expect(result.type).toBe("pause");
    if (result.type === "pause") {
      expect(result.reason).toBe("max_iterations");
    }
  });

  it("test_max_iterations_does_not_execute_engine_transition", () => {
    const { store, wf, iterationStore } = setup();
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");

    resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", "");

    const job = store.load("J000001");
    // current_phase should remain "plan" (no engine transition)
    expect(job.frontmatter.current_phase).toBe("plan");
  });

  it("test_max_iterations_does_not_increment_iteration", () => {
    const { store, wf, iterationStore } = setup();
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");
    expect(iterationStore.get("J000001")).toBe(3);

    resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", "");

    expect(iterationStore.get("J000001")).toBe(3);
  });

  it("test_max_iterations_appends_phase_log", () => {
    const { store, wf, iterationStore } = setup();
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");

    resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", "計画完了");

    const job = store.load("J000001");
    expect(job.body).toContain("フェーズログ");
  });
});

// ─── resolveAndExecuteTransition - human_review ───────────────────────────────

describe("resolveAndExecuteTransition - human_review", () => {
  it("test_human_review_phase_returns_pause_with_reason_human_review", () => {
    const { store, wf, iterationStore } = setup();
    // plan → completed → code → completed → review(human)
    const engine = new WorkflowEngine(wf, store);
    engine.transition("J000001", "completed", "");
    // now at code

    const result = resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", "実装完了");

    expect(result.type).toBe("pause");
    if (result.type === "pause") {
      expect(result.reason).toBe("human_review");
      expect(result.nextPhase).toBe("review");
    }
  });

  it("test_human_review_executes_engine_transition", () => {
    const { store, wf, iterationStore } = setup();
    const engine = new WorkflowEngine(wf, store);
    engine.transition("J000001", "completed", "");
    // now at code

    resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", "");

    const job = store.load("J000001");
    // engine transition should have moved to review phase
    expect(job.frontmatter.current_phase).toBe("review");
  });

  it("test_human_review_increments_iteration", () => {
    const { store, wf, iterationStore } = setup();
    const engine = new WorkflowEngine(wf, store);
    engine.transition("J000001", "completed", "");
    expect(iterationStore.get("J000001")).toBe(0);

    resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", "");

    expect(iterationStore.get("J000001")).toBe(1);
  });
});

// ─── resolveAndExecuteTransition - 自動遷移 (continue) ────────────────────────

describe("resolveAndExecuteTransition - 自動遷移 (continue)", () => {
  it("test_auto_continue_returns_continue_result", () => {
    const { store, wf, iterationStore } = setup();
    // plan → completed → code (自動遷移)

    const result = resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", "計画完了");

    expect(result.type).toBe("continue");
    expect(result.jobId).toBe("J000001");
    if (result.type === "continue") {
      expect(result.nextPhase).toBe("code");
    }
  });

  it("test_auto_continue_increments_iteration", () => {
    const { store, wf, iterationStore } = setup();
    expect(iterationStore.get("J000001")).toBe(0);

    resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", "");

    expect(iterationStore.get("J000001")).toBe(1);
  });

  it("test_auto_continue_executes_engine_transition", () => {
    const { store, wf, iterationStore } = setup();

    resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", "");

    const job = store.load("J000001");
    expect(job.frontmatter.current_phase).toBe("code");
  });

  it("test_auto_continue_includes_phase_config", () => {
    const { store, wf, iterationStore } = setup();

    const result = resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", "");

    expect(result.type).toBe("continue");
    if (result.type === "continue") {
      expect(result.phaseConfig.name).toBe("code");
      expect(result.phaseConfig.description).toBe("実装");
      expect(result.phaseConfig.agent).toBe("coder");
    }
  });
});

// ─── resolveAndExecuteTransition - reviewer phase approved/rejected ───────────

describe("resolveAndExecuteTransition - reviewer フェーズ", () => {
  it("test_reviewer_phase_approved_returns_done", () => {
    const { store, wf, iterationStore } = setup();
    const engine = new WorkflowEngine(wf, store);
    engine.transition("J000001", "completed", "");
    engine.transition("J000001", "completed", "");
    // now at review

    const result = resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "approved", "LGTM");

    expect(result.type).toBe("done");
    if (result.type === "done") {
      expect(result.status).toBe("completed");
    }
  });

  it("test_reviewer_phase_rejected_returns_continue_to_code", () => {
    const { store, wf, iterationStore } = setup();
    const engine = new WorkflowEngine(wf, store);
    engine.transition("J000001", "completed", "");
    engine.transition("J000001", "completed", "");
    // now at review

    const result = resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "rejected", "テスト不足");

    expect(result.type).toBe("continue");
    if (result.type === "continue") {
      expect(result.nextPhase).toBe("code");
    }
  });

  it("test_reviewer_phase_rejected_increments_iteration", () => {
    const { store, wf, iterationStore } = setup();
    const engine = new WorkflowEngine(wf, store);
    engine.transition("J000001", "completed", "");
    engine.transition("J000001", "completed", "");
    expect(iterationStore.get("J000001")).toBe(0);

    resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "rejected", "");

    expect(iterationStore.get("J000001")).toBe(1);
  });
});

// ─── resolveAndExecuteTransition - バリデーション ─────────────────────────────

describe("resolveAndExecuteTransition - バリデーション", () => {
  it("current_phase が未設定の場合エラーをスローする", () => {
    const { store, wf, iterationStore } = setup();
    const job = store.load("J000001");
    job.frontmatter.current_phase = undefined;
    store.save(job);

    expect(() =>
      resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", ""),
    ).toThrow("現在のフェーズが設定されていません");
  });

  it("running 以外のステータスの場合エラーをスローする", () => {
    const { store, wf, iterationStore } = setup();
    const job = store.load("J000001");
    job.frontmatter.status = "pending";
    store.save(job);

    expect(() =>
      resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", ""),
    ).toThrow("実行中ではありません");
  });

  it("completed ステータスの場合エラーをスローする", () => {
    const { store, wf, iterationStore } = setup();
    const job = store.load("J000001");
    job.frontmatter.status = "completed";
    store.save(job);

    expect(() =>
      resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", ""),
    ).toThrow("実行中ではありません");
  });

  it("レビューフェーズで completed を使うとエラーをスローする", () => {
    const { store, wf, iterationStore } = setup();
    const engine = new WorkflowEngine(wf, store);
    engine.transition("J000001", "completed", "");
    engine.transition("J000001", "completed", "");
    // now at review (reviewer phase)

    expect(() =>
      resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", ""),
    ).toThrow("approve/reject");
  });

  it("レビューフェーズで failed を使うとエラーをスローする", () => {
    const { store, wf, iterationStore } = setup();
    const engine = new WorkflowEngine(wf, store);
    engine.transition("J000001", "completed", "");
    engine.transition("J000001", "completed", "");

    expect(() =>
      resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "failed", ""),
    ).toThrow("approve/reject");
  });

  it("通常フェーズで approved を使うとエラーをスローする", () => {
    const { store, wf, iterationStore } = setup();
    // plan is a normal phase

    expect(() =>
      resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "approved", ""),
    ).toThrow("通常フェーズ");
  });

  it("通常フェーズで rejected を使うとエラーをスローする", () => {
    const { store, wf, iterationStore } = setup();

    expect(() =>
      resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "rejected", ""),
    ).toThrow("通常フェーズ");
  });
});

// ─── resolveAndExecuteTransition - agent reviewer auto-transition ─────────────

const AUTO_REVIEWER_CONFIG_YAML = `
workflows:
  dev:
    max_iterations: 10
    phases:
      - name: plan
        type: task
        description: 計画
        agent: planner
        on:
          completed: code
          failed: ABORT
      - name: code
        type: task
        description: 実装
        agent: coder
        on:
          completed: review
          failed: plan
      - name: review
        type: review
        description: レビュー
        reviewer: auto-reviewer
        on:
          approved: COMPLETE
          rejected: code
`;

describe("resolveAndExecuteTransition - agent reviewer auto-transition", () => {
  it("reviewer が human でない review フェーズへの遷移は continue を返す", () => {
    const dir = makeTmpDir();
    const store = new JobStore(dir);
    store.ensureDir();
    const config = SquadConfigImpl.parse(AUTO_REVIEWER_CONFIG_YAML);
    const iterationStore = new IterationStore(dir);
    const wf = config.getWorkflow("dev")!;
    const engine = new WorkflowEngine(wf, store);

    const job = makeJob("J000001", "pending", "dev");
    store.save(job);
    engine.startJob("J000001");

    // plan → completed → code
    engine.transition("J000001", "completed", "");
    // code → completed → review (auto-reviewer)

    const result = resolveAndExecuteTransition(wf, store, iterationStore, "J000001", "completed", "実装完了");

    expect(result.type).toBe("continue");
    if (result.type === "continue") {
      expect(result.nextPhase).toBe("review");
    }
  });
});

// ─── validateConditionForPhase ────────────────────────────────────────────────

describe("validateConditionForPhase", () => {
  it("test_normal_phase_accepts_completed", () => {
    const config = SquadConfigImpl.parse(CONFIG_YAML);
    const wf = config.getWorkflow("dev")!;

    expect(() => validateConditionForPhase(wf, "plan", "completed")).not.toThrow();
  });

  it("test_normal_phase_accepts_failed", () => {
    const config = SquadConfigImpl.parse(CONFIG_YAML);
    const wf = config.getWorkflow("dev")!;

    expect(() => validateConditionForPhase(wf, "plan", "failed")).not.toThrow();
  });

  it("test_normal_phase_rejects_approved", () => {
    const config = SquadConfigImpl.parse(CONFIG_YAML);
    const wf = config.getWorkflow("dev")!;

    expect(() => validateConditionForPhase(wf, "plan", "approved")).toThrow("通常フェーズ");
  });

  it("test_normal_phase_rejects_rejected", () => {
    const config = SquadConfigImpl.parse(CONFIG_YAML);
    const wf = config.getWorkflow("dev")!;

    expect(() => validateConditionForPhase(wf, "plan", "rejected")).toThrow("通常フェーズ");
  });

  it("test_reviewer_phase_accepts_approved", () => {
    const config = SquadConfigImpl.parse(CONFIG_YAML);
    const wf = config.getWorkflow("dev")!;

    expect(() => validateConditionForPhase(wf, "review", "approved")).not.toThrow();
  });

  it("test_reviewer_phase_accepts_rejected", () => {
    const config = SquadConfigImpl.parse(CONFIG_YAML);
    const wf = config.getWorkflow("dev")!;

    expect(() => validateConditionForPhase(wf, "review", "rejected")).not.toThrow();
  });

  it("test_reviewer_phase_rejects_completed", () => {
    const config = SquadConfigImpl.parse(CONFIG_YAML);
    const wf = config.getWorkflow("dev")!;

    expect(() => validateConditionForPhase(wf, "review", "completed")).toThrow("レビューフェーズ");
  });

  it("test_reviewer_phase_rejects_failed", () => {
    const config = SquadConfigImpl.parse(CONFIG_YAML);
    const wf = config.getWorkflow("dev")!;

    expect(() => validateConditionForPhase(wf, "review", "failed")).toThrow("レビューフェーズ");
  });

  it("test_unknown_phase_throws_error", () => {
    const config = SquadConfigImpl.parse(CONFIG_YAML);
    const wf = config.getWorkflow("dev")!;

    expect(() => validateConditionForPhase(wf, "nonexistent_phase", "completed")).toThrow();
  });
});
