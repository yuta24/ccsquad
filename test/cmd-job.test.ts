import { describe, it, expect, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdAdd,
  cmdList,
  cmdShow,
  cmdEdit,
  cmdUpdateSection,
  cmdRun,
  cmdTransition,
  cmdApprove,
  cmdReject,
  cmdAbort,
  cmdClose,
} from "../src/cli/commands/job.js";
import { JobStore } from "../src/infra/job-store.js";
import type { Job, JobStatus } from "../src/domain/types.js";
import { IterationStore } from "../src/infra/iteration-store.js";
import { OutputStore } from "../src/infra/output-store.js";
import { EntryStore } from "../src/infra/entry-store.js";
import { parseConfig } from "../src/infra/config-loader.js";
import type { ProjectContext } from "../src/app/project-context.js";

const DEV_CONFIG_YAML = `
workflows:
  dev:
    description: 開発ワークフロー
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
  return mkdtempSync(join(tmpdir(), "ccsquad-cmd-job-"));
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

function setup(): { ctx: ProjectContext } {
  const dir = makeTmpDir();
  const jobsDir = join(dir, "jobs");
  const memoryDir = join(dir, "memory");
  const outputsDir = join(dir, "outputs");
  const store = new JobStore(jobsDir);
  store.ensureDir();
  const workflows = parseConfig(DEV_CONFIG_YAML);
  const ctx: ProjectContext = {
    workflows,
    jobStore: store,
    iterationStore: new IterationStore(dir),
    entryStore: new EntryStore(memoryDir),
    outputStore: new OutputStore(outputsDir),
    projectRoot: dir,
    squadDir: dir,
    jobsDir,
    memoryDir,
    outputsDir,
  };
  return { ctx };
}

// ─── cmdAdd ──────────────────────────────────────────────────────────────────

describe("cmdAdd", () => {
  it("test_add_creates_job_with_correct_frontmatter", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "新機能の実装", "dev");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.id).toBe("J000001");
    expect(job.frontmatter.title).toBe("新機能の実装");
    expect(job.frontmatter.workflow).toBe("dev");
    expect(job.frontmatter.status).toBe("pending");
    expect(job.frontmatter.priority).toBe(0);
    expect(job.frontmatter.depends_on ?? []).toEqual([]);
  });

  it("test_add_with_description_sets_body", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", "dev", "詳細な説明文");
    const job = ctx.jobStore.load("J000001");
    expect(job.body).toContain("## 説明");
    expect(job.body).toContain("詳細な説明文");
  });

  it("test_add_without_description_leaves_empty_body", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", "dev");
    const job = ctx.jobStore.load("J000001");
    expect(job.body).toBe("");
  });

  it("test_add_with_depends_on", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));
    cmdAdd(ctx, "後続タスク", "dev", undefined, 0, ["J000001"]);
    const job = ctx.jobStore.load("J000002");
    expect(job.frontmatter.depends_on).toEqual(["J000001"]);
  });

  it("test_add_with_priority", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "高優先度タスク", "dev", undefined, 5);
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.priority).toBe(5);
  });

  it("test_add_rejects_invalid_workflow", () => {
    const { ctx } = setup();
    expect(() => cmdAdd(ctx, "タスク", "nonexistent")).toThrow();
  });

  it("test_add_increments_id_sequentially", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク1", "dev");
    cmdAdd(ctx, "タスク2", "dev");
    const job1 = ctx.jobStore.load("J000001");
    const job2 = ctx.jobStore.load("J000002");
    expect(job1.frontmatter.id).toBe("J000001");
    expect(job2.frontmatter.id).toBe("J000002");
  });
});

// ─── cmdRun ──────────────────────────────────────────────────────────────────

describe("cmdRun", () => {
  it("test_run_starts_pending_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.status).toBe("running");
    expect(job.frontmatter.current_phase).toBe("plan");
  });

  it("test_run_sets_initial_phase", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.current_phase).toBe("plan");
  });

  it("test_run_rejects_non_pending_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "running"));
    expect(() => cmdRun(ctx, "J000001")).toThrow();
  });

  it("test_run_rejects_completed_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));
    expect(() => cmdRun(ctx, "J000001")).toThrow();
  });

  it("test_run_rejects_job_with_incomplete_dependencies", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "running"));
    const job2 = makeJob("J000002", "pending");
    job2.frontmatter.depends_on = ["J000001"];
    ctx.jobStore.save(job2);
    expect(() => cmdRun(ctx, "J000002")).toThrow("未完了");
  });

  it("test_run_allows_start_when_dependency_is_completed", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));
    const job2 = makeJob("J000002", "pending");
    job2.frontmatter.depends_on = ["J000001"];
    ctx.jobStore.save(job2);
    expect(() => cmdRun(ctx, "J000002")).not.toThrow();
    const job = ctx.jobStore.load("J000002");
    expect(job.frontmatter.status).toBe("running");
  });
});

// ─── cmdTransition ────────────────────────────────────────────────────────────

describe("cmdTransition", () => {
  it("test_transition_completed_moves_to_next_phase", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    cmdTransition(ctx, "J000001", "completed", "計画完了");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.current_phase).toBe("code");
    expect(job.frontmatter.status).toBe("running");
  });

  it("test_transition_failed_moves_to_fallback_phase", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "failed", "ビルドエラー");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.current_phase).toBe("plan");
  });

  it("test_transition_to_terminal_complete", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdApprove(ctx, "J000001", "LGTM");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.status).toBe("completed");
  });

  it("test_transition_to_terminal_abort", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    cmdTransition(ctx, "J000001", "failed", "致命的エラー");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.status).toBe("failed");
    expect(job.frontmatter.current_phase).toBeUndefined();
  });

  it("test_transition_rejects_reviewer_phase", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "completed", "");
    // now at review (reviewer phase)
    expect(() => cmdTransition(ctx, "J000001", "completed", "")).toThrow("approved/rejected");
  });
});

// ─── cmdApprove ──────────────────────────────────────────────────────────────

describe("cmdApprove", () => {
  it("test_approve_reviewer_phase_completes_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdApprove(ctx, "J000001", "LGTM");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.status).toBe("completed");
    expect(job.frontmatter.current_phase).toBeUndefined();
  });

  it("test_approve_rejects_non_reviewer_phase", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    // currently at plan phase (not reviewer)
    expect(() => cmdApprove(ctx, "J000001", "")).toThrow("通常フェーズ");
  });
});

// ─── cmdReject ───────────────────────────────────────────────────────────────

describe("cmdReject", () => {
  it("test_reject_reviewer_phase_goes_back_to_code", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdReject(ctx, "J000001", "テスト不足");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.current_phase).toBe("code");
    expect(job.frontmatter.status).toBe("running");
  });

  it("test_reject_rejects_non_reviewer_phase", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    // currently at plan phase (not reviewer)
    expect(() => cmdReject(ctx, "J000001", "")).toThrow();
  });
});

// ─── cmdAbort ────────────────────────────────────────────────────────────────

describe("cmdAbort", () => {
  it("test_abort_running_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    cmdAbort(ctx, "J000001");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.status).toBe("aborted");
    expect(job.frontmatter.current_phase).toBeUndefined();
  });

  it("test_abort_running_job_appends_log", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    cmdAbort(ctx, "J000001");
    const job = ctx.jobStore.load("J000001");
    expect(job.body).toContain("手動中断");
  });

  it("test_abort_rejects_completed_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));
    expect(() => cmdAbort(ctx, "J000001")).toThrow();
  });

  it("test_abort_rejects_failed_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "failed"));
    expect(() => cmdAbort(ctx, "J000001")).toThrow();
  });
});

// ─── cmdClose ────────────────────────────────────────────────────────────────

describe("cmdClose", () => {
  it("test_close_running_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    cmdClose(ctx, "J000001");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.status).toBe("closed");
    expect(job.frontmatter.current_phase).toBeUndefined();
  });

  it("test_close_pending_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdClose(ctx, "J000001");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.status).toBe("closed");
  });

  it("test_close_rejects_already_closed_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "closed"));
    expect(() => cmdClose(ctx, "J000001")).toThrow("既にクローズ");
  });

  it("test_close_blocks_when_dependents_exist", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));
    const job2 = makeJob("J000002", "pending");
    job2.frontmatter.depends_on = ["J000001"];
    ctx.jobStore.save(job2);
    expect(() => cmdClose(ctx, "J000001")).toThrow("依存されています");
  });

  it("test_close_force_succeeds_with_dependents", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));
    const job2 = makeJob("J000002", "pending");
    job2.frontmatter.depends_on = ["J000001"];
    ctx.jobStore.save(job2);
    cmdClose(ctx, "J000001", true);
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.status).toBe("closed");
  });
});

// ─── cmdList ─────────────────────────────────────────────────────────────────

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

describe("cmdList", () => {
  it("test_list_shows_correct_columns", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "テストタスク", "dev");
    const lines = captureLog(() => cmdList(ctx));
    const header = lines[0];
    expect(header).toContain("ID");
    expect(header).toContain("タイトル");
    expect(header).toContain("ワークフロー");
    expect(header).toContain("ステータス");
    expect(header).toContain("フェーズ");
    expect(header).toContain("優先度");
    const dataLine = lines.find((l) => l.includes("J000001"));
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain("テストタスク");
    expect(dataLine).toContain("dev");
    expect(dataLine).toContain("pending");
  });

  it("test_list_shows_empty_message_when_no_jobs", () => {
    const { ctx } = setup();
    const lines = captureLog(() => cmdList(ctx));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("ジョブはありません。");
  });
});

// ─── cmdShow ─────────────────────────────────────────────────────────────────

describe("cmdShow", () => {
  it("test_show_text_format_displays_job_details", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "表示テスト", "dev");
    const lines = captureLog(() => cmdShow(ctx, "J000001", "text"));
    expect(lines.some((l) => l.includes("J000001"))).toBe(true);
    expect(lines.some((l) => l.includes("表示テスト"))).toBe(true);
    expect(lines.some((l) => l.includes("dev"))).toBe(true);
    expect(lines.some((l) => l.includes("pending"))).toBe(true);
  });

  it("test_show_json_format_includes_phase_config_when_running", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      cmdShow(ctx, "J000001", "json");
    } finally {
      spy.mockRestore();
    }
    const json = JSON.parse(lines.join("\n"));
    expect(json.id).toBe("J000001");
    expect(json.status).toBe("running");
    expect(json.current_phase).toBe("plan");
    expect(json.phase_config).toBeDefined();
    expect(json.phase_config.type).toBe("task");
    expect(json.phase_config.agent).toBe("planner");
  });

  it("test_show_throws_for_nonexistent_job", () => {
    const { ctx } = setup();
    expect(() => cmdShow(ctx, "J999999", "text")).toThrow();
  });
});

// ─── cmdEdit ─────────────────────────────────────────────────────────────────

describe("cmdEdit", () => {
  it("test_edit_title_updates_frontmatter", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "元のタイトル", "dev");
    cmdEdit(ctx, "J000001", "新しいタイトル");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.title).toBe("新しいタイトル");
  });

  it("test_edit_priority_updates_frontmatter", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", "dev");
    cmdEdit(ctx, "J000001", undefined, undefined, 10);
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.priority).toBe(10);
  });

  it("test_edit_description_creates_section_if_missing", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", "dev");
    cmdEdit(ctx, "J000001", undefined, "新しい説明文");
    const job = ctx.jobStore.load("J000001");
    expect(job.body).toContain("## 説明");
    expect(job.body).toContain("新しい説明文");
  });

  it("test_edit_description_replaces_existing_section", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", "dev", "最初の説明");
    cmdEdit(ctx, "J000001", undefined, "更新された説明");
    const job = ctx.jobStore.load("J000001");
    expect(job.body).toContain("更新された説明");
    expect(job.body).not.toContain("最初の説明");
  });

  it("test_edit_depends_on_validates_referenced_jobs", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク1", "dev");
    cmdAdd(ctx, "タスク2", "dev");
    cmdEdit(ctx, "J000002", undefined, undefined, undefined, ["J000001"]);
    const job = ctx.jobStore.load("J000002");
    expect(job.frontmatter.depends_on).toEqual(["J000001"]);
  });

  it("test_edit_depends_on_throws_for_nonexistent_dependency", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", "dev");
    expect(() => cmdEdit(ctx, "J000001", undefined, undefined, undefined, ["J999999"])).toThrow();
  });
});

// ─── cmdUpdateSection ─────────────────────────────────────────────────────────

describe("cmdUpdateSection", () => {
  it("空のボディに新しいセクションを追加する", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", "dev");
    cmdUpdateSection(ctx, "J000001", "実装内容", "コードを書いた");

    const job = ctx.jobStore.load("J000001");
    expect(job.body).toContain("## 実装内容");
    expect(job.body).toContain("コードを書いた");
  });

  it("既存セクションを更新する", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", "dev", { description: "初期内容" });
    cmdUpdateSection(ctx, "J000001", "実装内容", "最初の内容");
    cmdUpdateSection(ctx, "J000001", "実装内容", "更新された内容");

    const job = ctx.jobStore.load("J000001");
    expect(job.body).toContain("更新された内容");
    expect(job.body).not.toContain("最初の内容");
  });

  it("フェーズログの前にセクションを挿入する", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", "dev");
    // フェーズログを含むボディを直接設定
    const job = ctx.jobStore.load("J000001");
    job.body = "## 説明\n既存の説明\n\n## フェーズログ\n- ログ1\n";
    ctx.jobStore.save(job);

    cmdUpdateSection(ctx, "J000001", "実装内容", "新しい内容");

    const updated = ctx.jobStore.load("J000001");
    const implIdx = updated.body.indexOf("## 実装内容");
    const logIdx = updated.body.indexOf("## フェーズログ");
    expect(implIdx).not.toBe(-1);
    expect(logIdx).not.toBe(-1);
    expect(implIdx).toBeLessThan(logIdx);
    expect(updated.body).toContain("新しい内容");
    expect(updated.body).toContain("- ログ1");
  });

  it("既存セクションの更新で他セクションを壊さない", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", "dev");
    const job = ctx.jobStore.load("J000001");
    job.body = "## 説明\n初期説明\n\n## 実装内容\n古い内容\n\n## フェーズログ\n- ログ\n";
    ctx.jobStore.save(job);

    cmdUpdateSection(ctx, "J000001", "実装内容", "新しい内容");

    const updated = ctx.jobStore.load("J000001");
    expect(updated.body).toContain("## 説明");
    expect(updated.body).toContain("初期説明");
    expect(updated.body).toContain("新しい内容");
    expect(updated.body).not.toContain("古い内容");
    expect(updated.body).toContain("## フェーズログ");
    expect(updated.body).toContain("- ログ");
  });
});
