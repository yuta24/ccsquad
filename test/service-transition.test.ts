import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/infra/job-store.js";
import type { Job, JobStatus } from "../src/domain/types.js";
import { IterationStore } from "../src/infra/iteration-store.js";
import { OutputStore } from "../src/infra/output-store.js";
import { EntryStore } from "../src/infra/entry-store.js";
import { parseConfig } from "../src/infra/config-loader.js";
import { JobService } from "../src/app/job-service.js";
import { validateConditionForPhase } from "../src/domain/workflow.js";
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
  const jobsDir = join(dir, "jobs");
  const memoryDir = join(dir, "memory");
  const outputsDir = join(dir, "outputs");
  const store = new JobStore(jobsDir);
  store.ensureDir();
  const workflows = parseConfig(CONFIG_YAML);
  const iterationStore = new IterationStore(dir);
  const wf = workflows[workflow];

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

  const jobService = new JobService(ctx);

  const job = makeJob("J000001", "pending", workflow);
  store.save(job);
  jobService.start("J000001");

  return { dir, store, ctx, iterationStore, jobService, wf };
}

// ─── JobService.transition - 終端遷移 ───────────────────────────────────

describe("JobService.transition - 終端遷移 (COMPLETE)", () => {
  it("test_complete_transition_returns_done_with_completed_status", () => {
    const { jobService, iterationStore } = setup();
    // plan → completed → code → completed → review → approved → COMPLETE
    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");
    // now at review (reviewer phase)

    const result = jobService.transition("J000001", "approved", "LGTM");

    expect(result.type).toBe("done");
    expect(result.jobId).toBe("J000001");
    if (result.type === "done") {
      expect(result.status).toBe("completed");
    }
  });

  it("test_abort_transition_returns_done_with_failed_status", () => {
    const { jobService } = setup();
    // plan → failed → ABORT

    const result = jobService.transition("J000001", "failed", "致命的エラー");

    expect(result.type).toBe("done");
    expect(result.jobId).toBe("J000001");
    if (result.type === "done") {
      expect(result.status).toBe("failed");
    }
  });

  it("test_terminal_transition_removes_iteration", () => {
    const { jobService, iterationStore } = setup();
    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");
    // Manually increment iteration to simulate prior iterations
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");

    jobService.transition("J000001", "approved", "");

    expect(iterationStore.get("J000001")).toBe(0);
  });
});

// ─── JobService.transition - max_iterations ─────────────────────────────

describe("JobService.transition - max_iterations", () => {
  it("test_max_iterations_reached_returns_pause_with_reason_max_iterations", () => {
    const { jobService, iterationStore } = setup();
    // max_iterations = 3、3回目でブロック
    iterationStore.increment("J000001"); // 1
    iterationStore.increment("J000001"); // 2
    iterationStore.increment("J000001"); // 3 = max

    const result = jobService.transition("J000001", "completed", "計画完了");

    expect(result.type).toBe("pause");
    if (result.type === "pause") {
      expect(result.reason).toBe("max_iterations");
    }
  });

  it("test_max_iterations_does_not_execute_transition", () => {
    const { store, jobService, iterationStore } = setup();
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");

    jobService.transition("J000001", "completed", "");

    const job = store.load("J000001");
    // current_phase should remain "plan" (no transition)
    expect(job.frontmatter.current_phase).toBe("plan");
  });

  it("test_max_iterations_does_not_increment_iteration", () => {
    const { jobService, iterationStore } = setup();
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");
    expect(iterationStore.get("J000001")).toBe(3);

    jobService.transition("J000001", "completed", "");

    expect(iterationStore.get("J000001")).toBe(3);
  });

  it("test_max_iterations_appends_phase_log", () => {
    const { store, jobService, iterationStore } = setup();
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");
    iterationStore.increment("J000001");

    jobService.transition("J000001", "completed", "計画完了");

    const job = store.load("J000001");
    expect(job.body).toContain("フェーズログ");
  });
});

// ─── JobService.transition - human_review ───────────────────────────────

describe("JobService.transition - human_review", () => {
  it("test_human_review_phase_returns_pause_with_reason_human_review", () => {
    const { jobService } = setup();
    // plan → completed → code → completed → review(human)
    jobService.transition("J000001", "completed", "");
    // now at code

    const result = jobService.transition("J000001", "completed", "実装完了");

    expect(result.type).toBe("pause");
    if (result.type === "pause") {
      expect(result.reason).toBe("human_review");
      expect(result.nextPhase).toBe("review");
    }
  });

  it("test_human_review_executes_transition", () => {
    const { store, jobService } = setup();
    jobService.transition("J000001", "completed", "");
    // now at code

    jobService.transition("J000001", "completed", "");

    const job = store.load("J000001");
    // transition should have moved to review phase
    expect(job.frontmatter.current_phase).toBe("review");
  });

  it("test_human_review_increments_iteration", () => {
    const { jobService, iterationStore } = setup();
    jobService.transition("J000001", "completed", "");
    // Reset to check from 0 after the auto-continue increment
    const countAfterFirst = iterationStore.get("J000001");

    jobService.transition("J000001", "completed", "");

    expect(iterationStore.get("J000001")).toBe(countAfterFirst + 1);
  });
});

// ─── JobService.transition - 自動遷移 (continue) ────────────────────────

describe("JobService.transition - 自動遷移 (continue)", () => {
  it("test_auto_continue_returns_continue_result", () => {
    const { jobService } = setup();
    // plan → completed → code (自動遷移)

    const result = jobService.transition("J000001", "completed", "計画完了");

    expect(result.type).toBe("continue");
    expect(result.jobId).toBe("J000001");
    if (result.type === "continue") {
      expect(result.nextPhase).toBe("code");
    }
  });

  it("test_auto_continue_increments_iteration", () => {
    const { jobService, iterationStore } = setup();
    expect(iterationStore.get("J000001")).toBe(0);

    jobService.transition("J000001", "completed", "");

    expect(iterationStore.get("J000001")).toBe(1);
  });

  it("test_auto_continue_executes_transition", () => {
    const { store, jobService } = setup();

    jobService.transition("J000001", "completed", "");

    const job = store.load("J000001");
    expect(job.frontmatter.current_phase).toBe("code");
  });

  it("test_auto_continue_includes_phase_config", () => {
    const { jobService } = setup();

    const result = jobService.transition("J000001", "completed", "");

    expect(result.type).toBe("continue");
    if (result.type === "continue") {
      expect(result.phaseConfig.name).toBe("code");
      expect(result.phaseConfig.description).toBe("実装");
      expect(result.phaseConfig.agent).toBe("coder");
    }
  });
});

// ─── JobService.transition - reviewer phase approved/rejected ───────────

describe("JobService.transition - reviewer フェーズ", () => {
  it("test_reviewer_phase_approved_returns_done", () => {
    const { jobService } = setup();
    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");
    // now at review

    const result = jobService.transition("J000001", "approved", "LGTM");

    expect(result.type).toBe("done");
    if (result.type === "done") {
      expect(result.status).toBe("completed");
    }
  });

  it("test_reviewer_phase_rejected_returns_continue_to_code", () => {
    const { jobService } = setup();
    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");
    // now at review

    const result = jobService.transition("J000001", "rejected", "テスト不足");

    expect(result.type).toBe("continue");
    if (result.type === "continue") {
      expect(result.nextPhase).toBe("code");
    }
  });

  it("test_reviewer_phase_rejected_increments_iteration", () => {
    const { jobService, iterationStore } = setup();
    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");
    const countBefore = iterationStore.get("J000001");

    jobService.transition("J000001", "rejected", "");

    expect(iterationStore.get("J000001")).toBe(countBefore + 1);
  });
});

// ─── JobService.transition - バリデーション ─────────────────────────────

describe("JobService.transition - バリデーション", () => {
  it("current_phase が未設定の場合エラーをスローする", () => {
    const { store, jobService } = setup();
    const job = store.load("J000001");
    job.frontmatter.current_phase = undefined;
    store.save(job);

    expect(() =>
      jobService.transition("J000001", "completed", ""),
    ).toThrow("現在のフェーズが設定されていません");
  });

  it("running 以外のステータスの場合エラーをスローする", () => {
    const { store, jobService } = setup();
    const job = store.load("J000001");
    job.frontmatter.status = "pending";
    store.save(job);

    expect(() =>
      jobService.transition("J000001", "completed", ""),
    ).toThrow("実行中ではありません");
  });

  it("completed ステータスの場合エラーをスローする", () => {
    const { store, jobService } = setup();
    const job = store.load("J000001");
    job.frontmatter.status = "completed";
    store.save(job);

    expect(() =>
      jobService.transition("J000001", "completed", ""),
    ).toThrow("実行中ではありません");
  });

  it("レビューフェーズで completed を使うとエラーをスローする", () => {
    const { jobService } = setup();
    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");
    // now at review (reviewer phase)

    expect(() =>
      jobService.transition("J000001", "completed", ""),
    ).toThrow("approved/rejected");
  });

  it("レビューフェーズで failed を使うとエラーをスローする", () => {
    const { jobService } = setup();
    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");

    expect(() =>
      jobService.transition("J000001", "failed", ""),
    ).toThrow("approved/rejected");
  });

  it("通常フェーズで approved を使うとエラーをスローする", () => {
    const { jobService } = setup();
    // plan is a normal phase

    expect(() =>
      jobService.transition("J000001", "approved", ""),
    ).toThrow("通常フェーズ");
  });

  it("通常フェーズで rejected を使うとエラーをスローする", () => {
    const { jobService } = setup();

    expect(() =>
      jobService.transition("J000001", "rejected", ""),
    ).toThrow("通常フェーズ");
  });
});

// ─── JobService.transition - agent reviewer auto-transition ─────────────

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

describe("JobService.transition - agent reviewer auto-transition", () => {
  it("reviewer が human でない review フェーズへの遷移は continue を返す", () => {
    const dir = makeTmpDir();
    const jobsDir = join(dir, "jobs");
    const memoryDir = join(dir, "memory");
    const outputsDir = join(dir, "outputs");
    const store = new JobStore(jobsDir);
    store.ensureDir();
    const workflows = parseConfig(AUTO_REVIEWER_CONFIG_YAML);
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

    const jobService = new JobService(ctx);

    const job = makeJob("J000001", "pending", "dev");
    store.save(job);
    jobService.start("J000001");

    // plan → completed → code
    jobService.transition("J000001", "completed", "");
    // code → completed → review (auto-reviewer)

    const result = jobService.transition("J000001", "completed", "実装完了");

    expect(result.type).toBe("continue");
    if (result.type === "continue") {
      expect(result.nextPhase).toBe("review");
    }
  });
});

// ─── validateConditionForPhase ────────────────────────────────────────────────

describe("validateConditionForPhase", () => {
  it("test_normal_phase_accepts_completed", () => {
    expect(() => validateConditionForPhase("task", "completed")).not.toThrow();
  });

  it("test_normal_phase_accepts_failed", () => {
    expect(() => validateConditionForPhase("task", "failed")).not.toThrow();
  });

  it("test_normal_phase_rejects_approved", () => {
    expect(() => validateConditionForPhase("task", "approved")).toThrow("通常フェーズ");
  });

  it("test_normal_phase_rejects_rejected", () => {
    expect(() => validateConditionForPhase("task", "rejected")).toThrow("通常フェーズ");
  });

  it("test_reviewer_phase_accepts_approved", () => {
    expect(() => validateConditionForPhase("review", "approved")).not.toThrow();
  });

  it("test_reviewer_phase_accepts_rejected", () => {
    expect(() => validateConditionForPhase("review", "rejected")).not.toThrow();
  });

  it("test_reviewer_phase_rejects_completed", () => {
    expect(() => validateConditionForPhase("review", "completed")).toThrow("レビューフェーズ");
  });

  it("test_reviewer_phase_rejects_failed", () => {
    expect(() => validateConditionForPhase("review", "failed")).toThrow("レビューフェーズ");
  });
});
