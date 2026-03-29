import { describe, it, expect, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdAdd,
  cmdList,
  cmdShow,
  cmdRun,
  cmdTransition,
  cmdApprove,
  cmdReject,
  cmdAbort,
} from "../src/cli/commands/job.js";
import { JobStore } from "../src/infra/job-store.js";
import type { Job, JobStatus } from "../src/domain/types.js";
import type { ProjectContext } from "../src/app/project-context.js";
import { createTestContext } from "./helpers.js";

const PHASES = "plan:plan,code:execute,review:review";
const TRANSITIONS = "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>COMPLETE,review:rejected>code";

const WORKFLOW_BODY = `## Acceptance Criteria

- [ ] テスト基準

## Workflow

- plan: plan -> completed:code, failed:ABORT
- code: execute -> completed:review, failed:plan
- review: review -> approved:COMPLETE, rejected:code
`;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ccsquad-cmd-job-"));
}

function makeJob(id: string, status: JobStatus): Job {
  const now = new Date().toISOString();
  return {
    frontmatter: {
      id,
      title: "テスト",
      status,
      iteration: 0,
      max_iterations: 10,
      priority: 0,
      depends_on: [],
      created_at: now,
      updated_at: now,
    },
    body: WORKFLOW_BODY,
  };
}

function setup(): { ctx: ProjectContext } {
  const ctx = createTestContext("ccsquad-cmd-job-");
  return { ctx };
}

// ─── cmdAdd ──────────────────────────────────────────────────────────────────

describe("cmdAdd", () => {
  it("test_add_creates_job_with_correct_frontmatter", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "新機能の実装", PHASES, TRANSITIONS);
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.id).toBe("J000001");
    expect(job.frontmatter.title).toBe("新機能の実装");
    expect(job.frontmatter.status).toBe("pending");
    expect(job.frontmatter.priority).toBe(0);
    expect(job.frontmatter.depends_on ?? []).toEqual([]);
  });

  it("test_add_creates_workflow_section_in_body", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", PHASES, TRANSITIONS);
    const job = ctx.jobStore.load("J000001");
    expect(job.body).toContain("## Workflow");
    expect(job.body).toContain("plan: plan");
    expect(job.body).toContain("code: execute");
    expect(job.body).toContain("review: review");
  });

  it("test_add_with_description_sets_body", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", PHASES, TRANSITIONS, "詳細な説明文");
    const job = ctx.jobStore.load("J000001");
    expect(job.body).toContain("## 説明");
    expect(job.body).toContain("詳細な説明文");
    expect(job.body).toContain("## Workflow");
  });

  it("test_add_without_description_has_workflow_only", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", PHASES, TRANSITIONS);
    const job = ctx.jobStore.load("J000001");
    expect(job.body).not.toContain("## 説明");
    expect(job.body).toContain("## Workflow");
  });

  it("test_add_with_depends_on", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));
    cmdAdd(ctx, "後続タスク", PHASES, TRANSITIONS, undefined, 0, ["J000001"]);
    const job = ctx.jobStore.load("J000002");
    expect(job.frontmatter.depends_on).toEqual(["J000001"]);
  });

  it("test_add_with_priority", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "高優先度タスク", PHASES, TRANSITIONS, undefined, 5);
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.priority).toBe(5);
  });

  it("test_add_with_max_iterations", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", PHASES, TRANSITIONS, undefined, 0, [], 5);
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.max_iterations).toBe(5);
  });

  it("test_add_increments_id_sequentially", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク1", PHASES, TRANSITIONS);
    cmdAdd(ctx, "タスク2", PHASES, TRANSITIONS);
    const job1 = ctx.jobStore.load("J000001");
    const job2 = ctx.jobStore.load("J000002");
    expect(job1.frontmatter.id).toBe("J000001");
    expect(job2.frontmatter.id).toBe("J000002");
  });

  it("test_add_rejects_invalid_phase_type", () => {
    const { ctx } = setup();
    expect(() => cmdAdd(ctx, "タスク", "plan:invalid", "plan:completed>COMPLETE")).toThrow();
  });

  it("test_add_with_agent_creates_workflow_with_agent", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", "plan:plan:planner,code:execute:coder,review:review:reviewer",
      "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>COMPLETE,review:rejected>code");
    const job = ctx.jobStore.load("J000001");
    expect(job.body).toContain("[planner]");
    expect(job.body).toContain("[coder]");
    expect(job.body).toContain("[reviewer]");
  });

  it("test_add_with_mixed_agent_and_no_agent", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", "plan:plan,code:execute:coder,review:review",
      "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>COMPLETE,review:rejected>code");
    const job = ctx.jobStore.load("J000001");
    expect(job.body).toContain("[coder]");
    expect(job.body).not.toContain("[developer]");
    expect(job.body).not.toContain("[reviewer]");
  });

  it("test_add_rejects_invalid_phase_format_too_many_colons", () => {
    const { ctx } = setup();
    expect(() => cmdAdd(ctx, "タスク", "plan:plan:agent:extra", "plan:completed>COMPLETE")).toThrow("フェーズ定義の形式が不正です");
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

  it("test_run_rejects_non_pending_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "running"));
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
});

// ─── cmdApprove / cmdReject ──────────────────────────────────────────────────

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
  });

  it("test_approve_rejects_non_reviewer_phase", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    expect(() => cmdApprove(ctx, "J000001", "")).toThrow("通常フェーズ");
  });
});

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

  it("test_abort_rejects_completed_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));
    expect(() => cmdAbort(ctx, "J000001")).toThrow();
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
    cmdAdd(ctx, "テストタスク", PHASES, TRANSITIONS);
    const lines = captureLog(() => cmdList(ctx));
    const header = lines[0];
    expect(header).toContain("ID");
    expect(header).toContain("タイトル");
    expect(header).toContain("ステータス");
    expect(header).toContain("フェーズ");
    expect(header).toContain("優先度");
    const dataLine = lines.find((l) => l.includes("J000001"));
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain("テストタスク");
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
    cmdAdd(ctx, "表示テスト", PHASES, TRANSITIONS);
    const lines = captureLog(() => cmdShow(ctx, "J000001", "text"));
    expect(lines.some((l) => l.includes("J000001"))).toBe(true);
    expect(lines.some((l) => l.includes("表示テスト"))).toBe(true);
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
    expect(json.phase_config.type).toBe("plan");
  });

  it("test_show_json_includes_agent_field", () => {
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
    expect(json.phase_config.agent).toBe("developer");
  });

  it("test_show_throws_for_nonexistent_job", () => {
    const { ctx } = setup();
    expect(() => cmdShow(ctx, "J999999", "text")).toThrow();
  });
});
