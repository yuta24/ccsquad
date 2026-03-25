import { describe, it, expect, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdAdd,
  cmdList,
  cmdShow,
  cmdEdit,
  cmdRun,
  cmdTransition,
  cmdApprove,
  cmdReject,
  cmdAbort,
  cmdClose,
} from "../src/commands/job.js";
import { JobStore } from "../src/job.js";
import type { Job, JobStatus } from "../src/job.js";
import { IterationStore } from "../src/iteration.js";
import { SquadConfigImpl } from "../src/config.js";

const DEV_CONFIG_YAML = `
workflows:
  dev:
    description: 開発ワークフロー
    phases:
      - name: plan
        description: 計画
        agent: planner
        on:
          completed: code
          failed: ABORT
      - name: code
        description: 実装
        agent: coder
        on:
          completed: review
          failed: plan
      - name: review
        description: レビュー
        agent: reviewer
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

function setup() {
  const dir = makeTmpDir();
  const store = new JobStore(dir);
  store.ensureDir();
  const config = SquadConfigImpl.parse(DEV_CONFIG_YAML);
  return { dir, store, config };
}

// ─── cmdAdd ──────────────────────────────────────────────────────────────────

describe("cmdAdd", () => {
  it("test_add_creates_job_with_correct_frontmatter", () => {
    const { store, config } = setup();
    cmdAdd(store, config, "新機能の実装", "dev");
    const job = store.load("J000001");
    expect(job.frontmatter.id).toBe("J000001");
    expect(job.frontmatter.title).toBe("新機能の実装");
    expect(job.frontmatter.workflow).toBe("dev");
    expect(job.frontmatter.status).toBe("pending");
    expect(job.frontmatter.priority).toBe(0);
    expect(job.frontmatter.depends_on ?? []).toEqual([]);
  });

  it("test_add_with_description_sets_body", () => {
    const { store, config } = setup();
    cmdAdd(store, config, "タスク", "dev", "詳細な説明文");
    const job = store.load("J000001");
    expect(job.body).toContain("## 説明");
    expect(job.body).toContain("詳細な説明文");
  });

  it("test_add_without_description_leaves_empty_body", () => {
    const { store, config } = setup();
    cmdAdd(store, config, "タスク", "dev");
    const job = store.load("J000001");
    expect(job.body).toBe("");
  });

  it("test_add_with_depends_on", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "completed"));
    cmdAdd(store, config, "後続タスク", "dev", undefined, 0, ["J000001"]);
    const job = store.load("J000002");
    expect(job.frontmatter.depends_on).toEqual(["J000001"]);
  });

  it("test_add_with_priority", () => {
    const { store, config } = setup();
    cmdAdd(store, config, "高優先度タスク", "dev", undefined, 5);
    const job = store.load("J000001");
    expect(job.frontmatter.priority).toBe(5);
  });

  it("test_add_rejects_invalid_workflow", () => {
    const { store, config } = setup();
    expect(() => cmdAdd(store, config, "タスク", "nonexistent")).toThrow();
  });

  it("test_add_increments_id_sequentially", () => {
    const { store, config } = setup();
    cmdAdd(store, config, "タスク1", "dev");
    cmdAdd(store, config, "タスク2", "dev");
    const job1 = store.load("J000001");
    const job2 = store.load("J000002");
    expect(job1.frontmatter.id).toBe("J000001");
    expect(job2.frontmatter.id).toBe("J000002");
  });
});

// ─── cmdRun ──────────────────────────────────────────────────────────────────

describe("cmdRun", () => {
  it("test_run_starts_pending_job", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    const job = store.load("J000001");
    expect(job.frontmatter.status).toBe("running");
    expect(job.frontmatter.current_phase).toBe("plan");
  });

  it("test_run_sets_initial_phase", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    const job = store.load("J000001");
    expect(job.frontmatter.current_phase).toBe("plan");
  });

  it("test_run_rejects_non_pending_job", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "running"));
    expect(() => cmdRun(store, config, "J000001")).toThrow();
  });

  it("test_run_rejects_completed_job", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "completed"));
    expect(() => cmdRun(store, config, "J000001")).toThrow();
  });

  it("test_run_rejects_job_with_incomplete_dependencies", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "running"));
    const job2 = makeJob("J000002", "pending");
    job2.frontmatter.depends_on = ["J000001"];
    store.save(job2);
    expect(() => cmdRun(store, config, "J000002")).toThrow("未完了");
  });

  it("test_run_allows_start_when_dependency_is_completed", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "completed"));
    const job2 = makeJob("J000002", "pending");
    job2.frontmatter.depends_on = ["J000001"];
    store.save(job2);
    expect(() => cmdRun(store, config, "J000002")).not.toThrow();
    const job = store.load("J000002");
    expect(job.frontmatter.status).toBe("running");
  });
});

// ─── cmdTransition ────────────────────────────────────────────────────────────

describe("cmdTransition", () => {
  it("test_transition_completed_moves_to_next_phase", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    cmdTransition(store, config, "J000001", "completed", "計画完了");
    const job = store.load("J000001");
    expect(job.frontmatter.current_phase).toBe("code");
    expect(job.frontmatter.status).toBe("running");
  });

  it("test_transition_failed_moves_to_fallback_phase", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    cmdTransition(store, config, "J000001", "completed", "");
    cmdTransition(store, config, "J000001", "failed", "ビルドエラー");
    const job = store.load("J000001");
    expect(job.frontmatter.current_phase).toBe("plan");
  });

  it("test_transition_to_terminal_complete", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    cmdTransition(store, config, "J000001", "completed", "");
    cmdTransition(store, config, "J000001", "completed", "");
    cmdApprove(store, config, "J000001", "LGTM");
    const job = store.load("J000001");
    expect(job.frontmatter.status).toBe("completed");
  });

  it("test_transition_to_terminal_abort", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    cmdTransition(store, config, "J000001", "failed", "致命的エラー");
    const job = store.load("J000001");
    expect(job.frontmatter.status).toBe("failed");
    expect(job.frontmatter.current_phase).toBeUndefined();
  });

  it("test_transition_rejects_reviewer_phase", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    cmdTransition(store, config, "J000001", "completed", "");
    cmdTransition(store, config, "J000001", "completed", "");
    // now at review (reviewer phase)
    expect(() => cmdTransition(store, config, "J000001", "completed", "")).toThrow("approve/reject");
  });
});

// ─── cmdApprove ──────────────────────────────────────────────────────────────

describe("cmdApprove", () => {
  it("test_approve_reviewer_phase_completes_job", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    cmdTransition(store, config, "J000001", "completed", "");
    cmdTransition(store, config, "J000001", "completed", "");
    cmdApprove(store, config, "J000001", "LGTM");
    const job = store.load("J000001");
    expect(job.frontmatter.status).toBe("completed");
    expect(job.frontmatter.current_phase).toBeUndefined();
  });

  it("test_approve_rejects_non_reviewer_phase", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    // currently at plan phase (not reviewer)
    expect(() => cmdApprove(store, config, "J000001", "")).toThrow("レビュアー");
  });
});

// ─── cmdReject ───────────────────────────────────────────────────────────────

describe("cmdReject", () => {
  it("test_reject_reviewer_phase_goes_back_to_code", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    cmdTransition(store, config, "J000001", "completed", "");
    cmdTransition(store, config, "J000001", "completed", "");
    cmdReject(store, config, "J000001", "テスト不足");
    const job = store.load("J000001");
    expect(job.frontmatter.current_phase).toBe("code");
    expect(job.frontmatter.status).toBe("running");
  });

  it("test_reject_rejects_non_reviewer_phase", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    // currently at plan phase (not reviewer)
    expect(() => cmdReject(store, config, "J000001", "")).toThrow();
  });
});

// ─── cmdAbort ────────────────────────────────────────────────────────────────

describe("cmdAbort", () => {
  it("test_abort_running_job", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    cmdAbort(store, config, "J000001");
    const job = store.load("J000001");
    expect(job.frontmatter.status).toBe("aborted");
    expect(job.frontmatter.current_phase).toBeUndefined();
  });

  it("test_abort_running_job_appends_log", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    cmdAbort(store, config, "J000001");
    const job = store.load("J000001");
    expect(job.body).toContain("手動中断");
  });

  it("test_abort_rejects_completed_job", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "completed"));
    expect(() => cmdAbort(store, config, "J000001")).toThrow();
  });

  it("test_abort_rejects_failed_job", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "failed"));
    expect(() => cmdAbort(store, config, "J000001")).toThrow();
  });
});

// ─── cmdClose ────────────────────────────────────────────────────────────────

describe("cmdClose", () => {
  it("test_close_running_job", () => {
    const { dir, store, config } = setup();
    const iterationStore = new IterationStore(dir);
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    cmdClose(store, config, iterationStore, "J000001");
    const job = store.load("J000001");
    expect(job.frontmatter.status).toBe("closed");
    expect(job.frontmatter.current_phase).toBeUndefined();
  });

  it("test_close_removes_iteration", () => {
    const { dir, store, config } = setup();
    const iterationStore = new IterationStore(dir);
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    iterationStore.increment("J000001");
    expect(iterationStore.get("J000001")).toBe(1);
    cmdClose(store, config, iterationStore, "J000001");
    expect(iterationStore.get("J000001")).toBe(0);
  });

  it("test_close_pending_job", () => {
    const { dir, store, config } = setup();
    const iterationStore = new IterationStore(dir);
    store.save(makeJob("J000001", "pending"));
    cmdClose(store, config, iterationStore, "J000001");
    const job = store.load("J000001");
    expect(job.frontmatter.status).toBe("closed");
  });

  it("test_close_rejects_already_closed_job", () => {
    const { dir, store, config } = setup();
    const iterationStore = new IterationStore(dir);
    store.save(makeJob("J000001", "closed"));
    expect(() => cmdClose(store, config, iterationStore, "J000001")).toThrow("既にクローズ");
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
    const { store, config } = setup();
    cmdAdd(store, config, "テストタスク", "dev");
    const lines = captureLog(() => cmdList(store));
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
    const { store } = setup();
    const lines = captureLog(() => cmdList(store));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("ジョブはありません。");
  });
});

// ─── cmdShow ─────────────────────────────────────────────────────────────────

describe("cmdShow", () => {
  it("test_show_text_format_displays_job_details", () => {
    const { store, config } = setup();
    cmdAdd(store, config, "表示テスト", "dev");
    const lines = captureLog(() => cmdShow(store, config, "J000001", "text"));
    expect(lines.some((l) => l.includes("J000001"))).toBe(true);
    expect(lines.some((l) => l.includes("表示テスト"))).toBe(true);
    expect(lines.some((l) => l.includes("dev"))).toBe(true);
    expect(lines.some((l) => l.includes("pending"))).toBe(true);
  });

  it("test_show_json_format_includes_phase_config_when_running", () => {
    const { store, config } = setup();
    store.save(makeJob("J000001", "pending"));
    cmdRun(store, config, "J000001");
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      cmdShow(store, config, "J000001", "json");
    } finally {
      spy.mockRestore();
    }
    const json = JSON.parse(lines.join("\n"));
    expect(json.id).toBe("J000001");
    expect(json.status).toBe("running");
    expect(json.current_phase).toBe("plan");
    expect(json.phase_config).toBeDefined();
    expect(json.phase_config.agent).toBe("planner");
  });

  it("test_show_throws_for_nonexistent_job", () => {
    const { store, config } = setup();
    expect(() => cmdShow(store, config, "J999999", "text")).toThrow();
  });
});

// ─── cmdEdit ─────────────────────────────────────────────────────────────────

describe("cmdEdit", () => {
  it("test_edit_title_updates_frontmatter", () => {
    const { store, config } = setup();
    cmdAdd(store, config, "元のタイトル", "dev");
    cmdEdit(store, "J000001", "新しいタイトル");
    const job = store.load("J000001");
    expect(job.frontmatter.title).toBe("新しいタイトル");
  });

  it("test_edit_priority_updates_frontmatter", () => {
    const { store, config } = setup();
    cmdAdd(store, config, "タスク", "dev");
    cmdEdit(store, "J000001", undefined, undefined, 10);
    const job = store.load("J000001");
    expect(job.frontmatter.priority).toBe(10);
  });

  it("test_edit_description_creates_section_if_missing", () => {
    const { store, config } = setup();
    cmdAdd(store, config, "タスク", "dev");
    cmdEdit(store, "J000001", undefined, "新しい説明文");
    const job = store.load("J000001");
    expect(job.body).toContain("## 説明");
    expect(job.body).toContain("新しい説明文");
  });

  it("test_edit_description_replaces_existing_section", () => {
    const { store, config } = setup();
    cmdAdd(store, config, "タスク", "dev", "最初の説明");
    cmdEdit(store, "J000001", undefined, "更新された説明");
    const job = store.load("J000001");
    expect(job.body).toContain("更新された説明");
    expect(job.body).not.toContain("最初の説明");
  });

  it("test_edit_depends_on_validates_referenced_jobs", () => {
    const { store, config } = setup();
    cmdAdd(store, config, "タスク1", "dev");
    cmdAdd(store, config, "タスク2", "dev");
    cmdEdit(store, "J000002", undefined, undefined, undefined, ["J000001"]);
    const job = store.load("J000002");
    expect(job.frontmatter.depends_on).toEqual(["J000001"]);
  });

  it("test_edit_depends_on_throws_for_nonexistent_dependency", () => {
    const { store, config } = setup();
    cmdAdd(store, config, "タスク", "dev");
    expect(() => cmdEdit(store, "J000001", undefined, undefined, undefined, ["J999999"])).toThrow();
  });
});
