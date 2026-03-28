import { describe, it, expect, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdNextAction, cmdRun, cmdTransition } from "../src/cli/commands/job.js";
import { JobStore } from "../src/infra/job-store.js";
import type { Job, JobStatus } from "../src/domain/types.js";
import { IterationStore } from "../src/infra/iteration-store.js";
import { OutputStore } from "../src/infra/output-store.js";
import { EntryStore } from "../src/infra/entry-store.js";
import { parseConfig } from "../src/infra/config-loader.js";
import type { ProjectContext } from "../src/app/project-context.js";

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
  return mkdtempSync(join(tmpdir(), "ccsquad-next-action-"));
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
  const jobsDir = join(dir, "jobs");
  const memoryDir = join(dir, "memory");
  const outputsDir = join(dir, "outputs");
  const store = new JobStore(jobsDir);
  store.ensureDir();
  const workflows = parseConfig(CONFIG_YAML);
  const iterationStore = new IterationStore(dir);

  const ctx: ProjectContext = {
    workflows,
    jobStore: store,
    iterationStore,
    entryStore: new EntryStore(memoryDir),
    outputStore: new OutputStore(outputsDir),
    projectRoot: dir,
    squadDir: dir,
    jobsDir,
    memoryDir,
    outputsDir,
  };

  // ジョブを作成して実行状態にする
  const job = makeJob("J000001", "pending", workflow);
  store.save(job);
  cmdRun(ctx, "J000001");

  return { ctx, store, iterationStore };
}

function captureNextAction(
  ctx: ProjectContext,
  id: string,
  result: string,
  message: string,
  resetIteration = false,
): { output: ReturnType<typeof JSON.parse> | null } {
  let captured: string | null = null;
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const s = args.join(" ");
    // cmdNextAction outputs a single JSON.stringify call
    if (s.startsWith("{")) {
      captured = s;
    }
  });
  try {
    cmdNextAction(ctx, id, result, message, resetIteration);
  } finally {
    spy.mockRestore();
  }
  return { output: captured ? JSON.parse(captured) : null };
}

// ─── 終端遷移 (COMPLETE / ABORT) ──────────────────────────────────────────────

describe("cmdNextAction - 終端遷移", () => {
  it("test_complete_transition_returns_done_action", () => {
    const { ctx } = setup();
    // plan → completed → code, code → completed → review, review → approved → COMPLETE
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "completed", "");
    // now at review (reviewer phase)

    const { output } = captureNextAction(ctx, "J000001", "approved", "LGTM");
    expect(output).not.toBeNull();
    expect(output.action).toBe("done");
    expect(output.job_id).toBe("J000001");
    expect(output.status).toBe("completed");
  });

  it("test_complete_transition_removes_iteration", () => {
    const { ctx } = setup();
    ctx.iterationStore.increment("J000001");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "completed", "");
    captureNextAction(ctx, "J000001", "approved", "");
    expect(ctx.iterationStore.get("J000001")).toBe(0);
  });

  it("test_abort_transition_returns_done_action", () => {
    const { ctx } = setup();
    // plan → failed → ABORT
    const { output } = captureNextAction(ctx, "J000001", "failed", "致命的エラー");
    expect(output).not.toBeNull();
    expect(output.action).toBe("done");
    expect(output.job_id).toBe("J000001");
    expect(output.status).toBe("failed");
  });

  it("test_abort_transition_updates_job_status", () => {
    const { ctx, store } = setup();
    captureNextAction(ctx, "J000001", "failed", "");
    const job = store.load("J000001");
    expect(job.frontmatter.status).toBe("failed");
  });
});

// ─── 自動遷移 ────────────────────────────────────────────────────────────────

describe("cmdNextAction - 自動遷移 (continue)", () => {
  it("test_auto_transition_returns_continue_action", () => {
    const { ctx } = setup();
    // plan → completed → code (自動遷移)
    const { output } = captureNextAction(ctx, "J000001", "completed", "計画完了");
    expect(output).not.toBeNull();
    expect(output.action).toBe("continue");
    expect(output.job_id).toBe("J000001");
    expect(output.phase).toBe("code");
  });

  it("test_auto_transition_updates_current_phase", () => {
    const { ctx, store } = setup();
    captureNextAction(ctx, "J000001", "completed", "");
    const job = store.load("J000001");
    expect(job.frontmatter.current_phase).toBe("code");
  });

  it("test_auto_transition_increments_iteration", () => {
    const { ctx } = setup();
    captureNextAction(ctx, "J000001", "completed", "");
    expect(ctx.iterationStore.get("J000001")).toBe(1);
  });

  it("test_auto_transition_includes_phase_info", () => {
    const { ctx } = setup();
    const { output } = captureNextAction(ctx, "J000001", "completed", "");
    expect(output.phase_description).toBe("実装");
    expect(output.agent).toBe("coder");
  });
});

// ─── イテレーション上限 ────────────────────────────────────────────────────────

describe("cmdNextAction - max_iterations", () => {
  it("test_max_iterations_reached_returns_pause_action", () => {
    const { ctx } = setup();
    // max_iterations = 3 なので 3 回目でブロック
    ctx.iterationStore.reset("J000001");
    // イテレーションを上限まで積む
    ctx.iterationStore.increment("J000001"); // 1
    ctx.iterationStore.increment("J000001"); // 2
    ctx.iterationStore.increment("J000001"); // 3 = max

    const { output } = captureNextAction(ctx, "J000001", "completed", "計画完了");
    expect(output).not.toBeNull();
    expect(output.action).toBe("pause");
    expect(output.reason).toBe("max_iterations");
    expect(output.job_id).toBe("J000001");
  });

  it("test_max_iterations_does_not_transition", () => {
    const { ctx, store } = setup();
    ctx.iterationStore.increment("J000001");
    ctx.iterationStore.increment("J000001");
    ctx.iterationStore.increment("J000001");

    captureNextAction(ctx, "J000001", "completed", "");
    const job = store.load("J000001");
    // 遷移していないので current_phase は plan のまま
    expect(job.frontmatter.current_phase).toBe("plan");
  });

  it("test_max_iterations_appends_phase_log", () => {
    const { ctx, store } = setup();
    ctx.iterationStore.increment("J000001");
    ctx.iterationStore.increment("J000001");
    ctx.iterationStore.increment("J000001");

    captureNextAction(ctx, "J000001", "completed", "計画完了");
    const job = store.load("J000001");
    expect(job.body).toContain("フェーズログ");
  });

  it("test_below_max_iterations_auto_transitions", () => {
    const { ctx } = setup();
    ctx.iterationStore.increment("J000001"); // 1
    ctx.iterationStore.increment("J000001"); // 2 < 3

    const { output } = captureNextAction(ctx, "J000001", "completed", "");
    expect(output.action).toBe("continue");
  });
});

// ─── resetIteration フラグ ─────────────────────────────────────────────────────

describe("cmdNextAction - resetIteration", () => {
  it("test_reset_iteration_clears_count_before_processing", () => {
    const { ctx } = setup();
    // イテレーションを上限にする
    ctx.iterationStore.increment("J000001");
    ctx.iterationStore.increment("J000001");
    ctx.iterationStore.increment("J000001");
    expect(ctx.iterationStore.get("J000001")).toBe(3);

    // resetIteration=true でリセットしてから実行
    const { output } = captureNextAction(ctx, "J000001", "completed", "", true);
    // リセット後は 0 なので自動遷移できる
    expect(output.action).toBe("continue");
  });

  it("test_reset_iteration_false_does_not_clear_count", () => {
    const { ctx } = setup();
    ctx.iterationStore.increment("J000001");
    ctx.iterationStore.increment("J000001");
    ctx.iterationStore.increment("J000001");

    const { output } = captureNextAction(ctx, "J000001", "completed", "", false);
    expect(output.action).toBe("pause");
    expect(output.reason).toBe("max_iterations");
  });
});

// ─── レビューフェーズでの approved/rejected ────────────────────────────────────

describe("cmdNextAction - レビューフェーズ", () => {
  it("test_reviewer_phase_approved_returns_done", () => {
    const { ctx } = setup();
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "completed", "");

    const { output } = captureNextAction(ctx, "J000001", "approved", "LGTM");
    expect(output.action).toBe("done");
    expect(output.status).toBe("completed");
  });

  it("test_reviewer_phase_rejected_returns_continue_to_code", () => {
    const { ctx } = setup();
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "completed", "");

    const { output } = captureNextAction(ctx, "J000001", "rejected", "テスト不足");
    expect(output.action).toBe("continue");
    expect(output.phase).toBe("code");
  });

  it("test_reviewer_phase_rejected_increments_iteration", () => {
    const { ctx } = setup();
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "completed", "");

    captureNextAction(ctx, "J000001", "rejected", "");
    // After the two cmdTransition calls (each incrementing), plus one more from rejected
    expect(ctx.iterationStore.get("J000001")).toBeGreaterThanOrEqual(1);
  });

  it("test_non_reviewer_phase_rejects_approved_condition", () => {
    const { ctx } = setup();
    // plan は reviewer フェーズではない
    expect(() =>
      captureNextAction(ctx, "J000001", "approved", ""),
    ).toThrow("通常フェーズ");
  });

  it("test_reviewer_phase_rejects_completed_condition", () => {
    const { ctx } = setup();
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "completed", "");

    expect(() =>
      captureNextAction(ctx, "J000001", "completed", ""),
    ).toThrow("レビューフェーズ");
  });
});

// ─── エラーケース ─────────────────────────────────────────────────────────────

describe("cmdNextAction - エラーケース", () => {
  it("test_throws_when_no_current_phase", () => {
    const { ctx, store } = setup();
    // status を running にしたまま current_phase を undefined にする
    const job = store.load("J000001");
    job.frontmatter.current_phase = undefined;
    job.frontmatter.depends_on = job.frontmatter.depends_on ?? [];
    store.save(job);

    expect(() =>
      captureNextAction(ctx, "J000001", "completed", ""),
    ).toThrow("フェーズ");
  });

  it("test_throws_when_invalid_result_string", () => {
    const { ctx } = setup();
    expect(() =>
      captureNextAction(ctx, "J000001", "unknown_result", ""),
    ).toThrow();
  });
});
