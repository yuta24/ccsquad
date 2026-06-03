import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/infra/job-store.js";
import type { Job, JobStatus, WorkflowConfig } from "../src/domain/types.js";
import { JobService } from "../src/app/job-service.js";
import { validateConditionForPhase } from "../src/domain/workflow.js";
import type { ProjectContext } from "../src/app/project-context.js";
import { createTestContext } from "./helpers.js";

const WORKFLOW: WorkflowConfig = {
  phases: [
    { name: "plan", type: "plan", agent: "developer", on: { completed: "code", failed: "ABORT" } },
    { name: "code", type: "execute", agent: "developer", on: { completed: "review", failed: "plan" } },
    { name: "review", type: "review", agent: "reviewer", on: { approved: "COMPLETE", rejected: "code" } },
  ],
};

const AC_LIST = [{ description: "テスト基準", done: false }];

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ccsquad-svc-transition-"));
}

function makeJob(id: string, status: JobStatus): Job {
  const now = new Date().toISOString();
  return {
    frontmatter: {
      id,
      title: "テスト",
      status,
      iteration: 0,
      max_iterations: 3,
      depends_on: [],
      acceptance_criteria: AC_LIST,
      workflow: WORKFLOW,
      created_at: now,
      updated_at: now,
    },
    body: "",
  };
}

function setup() {
  const ctx = createTestContext("ccsquad-svc-transition-");
  const store = ctx.jobStore;
  const jobService = new JobService(ctx);

  const job = makeJob("J000001", "pending");
  store.save(job);
  jobService.start("J000001");

  return { dir: ctx.projectRoot, store, ctx, jobService };
}

// ─── JobService.transition - 終端遷移 ───────────────────────────────────

describe("JobService.transition - 終端遷移 (COMPLETE)", () => {
  it("test_complete_transition_returns_done_with_completed_status", () => {
    const { jobService } = setup();
    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");

    const result = jobService.transition("J000001", "approved", "LGTM");

    expect(result.type).toBe("done");
    expect(result.jobId).toBe("J000001");
    if (result.type === "done") {
      expect(result.status).toBe("completed");
    }
  });

  it("test_abort_transition_returns_done_with_failed_status", () => {
    const { jobService } = setup();

    const result = jobService.transition("J000001", "failed", "致命的エラー");

    expect(result.type).toBe("done");
    expect(result.jobId).toBe("J000001");
    if (result.type === "done") {
      expect(result.status).toBe("failed");
    }
  });
});

// ─── JobService.transition - max_iterations ─────────────────────────────

describe("JobService.transition - max_iterations", () => {
  it("test_max_iterations_reached_returns_pause_with_reason_max_iterations", () => {
    const { store, jobService } = setup();
    // Set iteration to max (3)
    const job = store.load("J000001");
    job.frontmatter.iteration = 3;
    store.save(job);

    const result = jobService.transition("J000001", "completed", "計画完了");

    expect(result.type).toBe("pause");
    if (result.type === "pause") {
      expect(result.reason).toBe("max_iterations");
    }
  });

  it("test_max_iterations_does_not_execute_transition", () => {
    const { store, jobService } = setup();
    const job = store.load("J000001");
    job.frontmatter.iteration = 3;
    store.save(job);

    jobService.transition("J000001", "completed", "");

    const updated = store.load("J000001");
    expect(updated.frontmatter.current_phase).toBe("plan");
  });

  it("test_max_iterations_does_not_increment_iteration", () => {
    const { store, jobService } = setup();
    const job = store.load("J000001");
    job.frontmatter.iteration = 3;
    store.save(job);

    jobService.transition("J000001", "completed", "");

    const updated = store.load("J000001");
    expect(updated.frontmatter.iteration).toBe(3);
  });

});

// ─── JobService.transition - human_review ───────────────────────────────

describe("JobService.transition - human_review", () => {
  it("test_review_phase_returns_pause_with_reason_human_review", () => {
    const { jobService } = setup();
    jobService.transition("J000001", "completed", "");

    const result = jobService.transition("J000001", "completed", "実装完了");

    expect(result.type).toBe("pause");
    if (result.type === "pause") {
      expect(result.reason).toBe("human_review");
      expect(result.nextPhase).toBe("review");
    }
  });

  it("test_review_executes_transition", () => {
    const { store, jobService } = setup();
    jobService.transition("J000001", "completed", "");

    jobService.transition("J000001", "completed", "");

    const job = store.load("J000001");
    expect(job.frontmatter.current_phase).toBe("review");
  });

  it("test_review_does_not_increment_iteration", () => {
    const { store, jobService } = setup();
    jobService.transition("J000001", "completed", "");
    const countAfterFirst = store.load("J000001").frontmatter.iteration;

    jobService.transition("J000001", "completed", "");

    expect(store.load("J000001").frontmatter.iteration).toBe(countAfterFirst);
  });
});

// ─── JobService.transition - 自動遷移 (continue) ────────────────────────

describe("JobService.transition - 自動遷移 (continue)", () => {
  it("test_auto_continue_returns_continue_result", () => {
    const { jobService } = setup();

    const result = jobService.transition("J000001", "completed", "計画完了");

    expect(result.type).toBe("continue");
    expect(result.jobId).toBe("J000001");
    if (result.type === "continue") {
      expect(result.nextPhase).toBe("code");
    }
  });

  it("test_auto_continue_increments_iteration", () => {
    const { store, jobService } = setup();
    expect(store.load("J000001").frontmatter.iteration).toBe(0);

    jobService.transition("J000001", "completed", "");

    expect(store.load("J000001").frontmatter.iteration).toBe(1);
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
      expect(result.phaseConfig.type).toBe("execute");
    }
  });
});

// ─── JobService.transition - reviewer phase approved/rejected ───────────

describe("JobService.transition - reviewer フェーズ", () => {
  it("test_reviewer_phase_approved_returns_done", () => {
    const { jobService } = setup();
    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");

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

    const result = jobService.transition("J000001", "rejected", "テスト不足");

    expect(result.type).toBe("continue");
    if (result.type === "continue") {
      expect(result.nextPhase).toBe("code");
    }
  });

  it("test_reviewer_phase_rejected_increments_iteration", () => {
    const { store, jobService } = setup();
    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");
    const countBefore = store.load("J000001").frontmatter.iteration;

    jobService.transition("J000001", "rejected", "");

    expect(store.load("J000001").frontmatter.iteration).toBe(countBefore + 1);
  });
});

// ─── JobService.transition - AC 自動更新 ───────────────────────────────

describe("JobService.transition - AC 自動更新", () => {
  it("approved 時は全 AC が done:true になる（メッセージ書式によらず）", () => {
    const { store, jobService } = setup();
    const job = store.load("J000001");
    job.frontmatter.acceptance_criteria = [
      { description: "テスト基準", done: false },
      { description: "セキュリティ", done: false },
    ];
    store.save(job);

    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");

    // チェックリスト書式でなくても全件 true になる
    jobService.transition("J000001", "approved", "全3件のACを確認。問題なし。");

    const updated = store.load("J000001");
    expect(updated.frontmatter.acceptance_criteria[0].done).toBe(true);
    expect(updated.frontmatter.acceptance_criteria[1].done).toBe(true);
  });

  it("rejected 時もチェック済み AC は更新される", () => {
    const { store, jobService } = setup();
    const job = store.load("J000001");
    job.frontmatter.acceptance_criteria = [
      { description: "テスト基準", done: false },
      { description: "セキュリティ", done: false },
    ];
    store.save(job);

    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");

    const reviewMessage = `## 検証結果
- [x] テスト基準: OK
- [ ] セキュリティ: NG`;
    jobService.transition("J000001", "rejected", reviewMessage);

    const updated = store.load("J000001");
    expect(updated.frontmatter.acceptance_criteria[0].done).toBe(true);
    expect(updated.frontmatter.acceptance_criteria[1].done).toBe(false);
  });

  it("一度 done: true になった AC は false に戻らない", () => {
    const { store, jobService } = setup();
    const job = store.load("J000001");
    job.frontmatter.acceptance_criteria = [
      { description: "テスト基準", done: true },
    ];
    store.save(job);

    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");

    const reviewMessage = "- [ ] テスト基準: 回帰テスト中";
    jobService.transition("J000001", "rejected", reviewMessage);

    const updated = store.load("J000001");
    expect(updated.frontmatter.acceptance_criteria[0].done).toBe(true);
  });

  it("plan/execute フェーズでは AC は更新されない", () => {
    const { store, jobService } = setup();
    const job = store.load("J000001");
    job.frontmatter.acceptance_criteria = [
      { description: "テスト基準", done: false },
    ];
    store.save(job);

    // plan → code 遷移（plan フェーズ）
    jobService.transition("J000001", "completed", "- [x] テスト基準: OK");

    const updated = store.load("J000001");
    expect(updated.frontmatter.acceptance_criteria[0].done).toBe(false);
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

// ─── validateConditionForPhase ────────────────────────────────────────────────

describe("validateConditionForPhase", () => {
  it("test_plan_phase_accepts_completed", () => {
    expect(() => validateConditionForPhase("plan", "completed")).not.toThrow();
  });

  it("test_plan_phase_accepts_failed", () => {
    expect(() => validateConditionForPhase("plan", "failed")).not.toThrow();
  });

  it("test_execute_phase_accepts_completed", () => {
    expect(() => validateConditionForPhase("execute", "completed")).not.toThrow();
  });

  it("test_execute_phase_accepts_failed", () => {
    expect(() => validateConditionForPhase("execute", "failed")).not.toThrow();
  });

  it("test_plan_phase_rejects_approved", () => {
    expect(() => validateConditionForPhase("plan", "approved")).toThrow("通常フェーズ");
  });

  it("test_execute_phase_rejects_rejected", () => {
    expect(() => validateConditionForPhase("execute", "rejected")).toThrow("通常フェーズ");
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
