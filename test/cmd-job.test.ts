import { describe, it, expect, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdAdd,
  cmdList,
  cmdShow,
  cmdRun,
  cmdTransition,
  cmdAbort,
  cmdUpdate,
  buildWorkflowConfig,
  parseWorkflowInput,
  parseAcInput,
} from "../src/cli/commands/job.js";
import { JobStore } from "../src/infra/job-store.js";
import type { Job, JobStatus, WorkflowConfig } from "../src/domain/types.js";
import type { ProjectContext } from "../src/app/project-context.js";
import { createTestContext } from "./helpers.js";

const PHASES = "plan:plan:developer,code:execute:developer,review:review:reviewer";
const TRANSITIONS = "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>COMPLETE,review:rejected>code";

const WORKFLOW: WorkflowConfig = {
  phases: [
    { name: "plan", type: "plan", agent: "developer", on: { completed: "code", failed: "ABORT" } },
    { name: "code", type: "execute", agent: "developer", on: { completed: "review", failed: "plan" } },
    { name: "review", type: "review", agent: "reviewer", on: { approved: "COMPLETE", rejected: "code" } },
  ],
};

const AC_LIST = [{ description: "テスト基準", done: false }];

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
      acceptance_criteria: AC_LIST,
      workflow: WORKFLOW,
      created_at: now,
      updated_at: now,
    },
    body: "",
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
    cmdAdd(ctx, "新機能の実装", WORKFLOW);
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.id).toBe("J000001");
    expect(job.frontmatter.title).toBe("新機能の実装");
    expect(job.frontmatter.status).toBe("pending");
    expect(job.frontmatter.priority).toBe(0);
    expect(job.frontmatter.depends_on ?? []).toEqual([]);
  });

  it("test_add_creates_workflow_in_frontmatter", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", WORKFLOW);
    const job = ctx.jobStore.load("J000001");
    const wf = job.frontmatter.workflow;
    expect(wf.phases).toHaveLength(3);
    expect(wf.phases[0].type).toBe("plan");
    expect(wf.phases[1].type).toBe("execute");
    expect(wf.phases[2].type).toBe("review");
  });

  it("test_add_with_description_sets_body", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", WORKFLOW, "詳細な説明文");
    const job = ctx.jobStore.load("J000001");
    expect(job.body).toContain("## 説明");
    expect(job.body).toContain("詳細な説明文");
  });

  it("test_add_without_description_has_empty_body", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", WORKFLOW);
    const job = ctx.jobStore.load("J000001");
    expect(job.body).not.toContain("## 説明");
  });

  it("test_add_with_depends_on", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));
    cmdAdd(ctx, "後続タスク", WORKFLOW, undefined, 0, ["J000001"]);
    const job = ctx.jobStore.load("J000002");
    expect(job.frontmatter.depends_on).toEqual(["J000001"]);
  });

  it("test_add_with_priority", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "高優先度タスク", WORKFLOW, undefined, 5);
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.priority).toBe(5);
  });

  it("test_add_with_max_iterations", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", WORKFLOW, undefined, 0, [], 5);
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.max_iterations).toBe(5);
  });

  it("test_add_increments_id_sequentially", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク1", WORKFLOW);
    cmdAdd(ctx, "タスク2", WORKFLOW);
    const job1 = ctx.jobStore.load("J000001");
    const job2 = ctx.jobStore.load("J000002");
    expect(job1.frontmatter.id).toBe("J000001");
    expect(job2.frontmatter.id).toBe("J000002");
  });

  it("test_add_with_agent_creates_workflow_with_agent", () => {
    const { ctx } = setup();
    const wf = buildWorkflowConfig("plan:plan:planner,code:execute:coder,review:review:reviewer",
      "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>COMPLETE,review:rejected>code");
    cmdAdd(ctx, "タスク", wf);
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.workflow.phases[0].agent).toBe("planner");
    expect(job.frontmatter.workflow.phases[1].agent).toBe("coder");
    expect(job.frontmatter.workflow.phases[2].agent).toBe("reviewer");
  });

});

// ─── buildWorkflowConfig ────────────────────────────────────────────────────

describe("buildWorkflowConfig", () => {
  it("test_rejects_invalid_phase_type", () => {
    expect(() => buildWorkflowConfig("plan:invalid:dev", "plan:completed>COMPLETE")).toThrow();
  });

  it("test_rejects_phase_without_agent", () => {
    expect(() => buildWorkflowConfig("plan:plan,code:execute:coder,review:review",
      "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>COMPLETE,review:rejected>code")).toThrow("フェーズ定義の形式が不正です");
  });

  it("test_rejects_invalid_phase_format_too_many_colons", () => {
    expect(() => buildWorkflowConfig("plan:plan:agent:auto:extra", "plan:completed>COMPLETE")).toThrow("フェーズ定義の形式が不正です");
  });
});

// ─── parseWorkflowInput ─────────────────────────────────────────────────────

describe("parseWorkflowInput", () => {
  it("test_parses_json_string", () => {
    const json = JSON.stringify({
      plan: { type: "plan", agent: "developer", on: { completed: "COMPLETE", failed: "ABORT" } },
    });
    const wf = parseWorkflowInput(json);
    expect(wf.phases).toHaveLength(1);
    expect(wf.phases[0].name).toBe("plan");
    expect(wf.phases[0].agent).toBe("developer");
  });

  it("test_parses_yaml_string", () => {
    const yaml = `plan:
  type: plan
  agent: developer
  on:
    completed: code
    failed: ABORT
code:
  type: execute
  agent: developer
  on:
    completed: COMPLETE
    failed: plan`;
    const wf = parseWorkflowInput(yaml);
    expect(wf.phases).toHaveLength(2);
    expect(wf.phases[0].name).toBe("plan");
    expect(wf.phases[1].name).toBe("code");
  });

  it("test_parses_file_path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsquad-wf-input-"));
    const filePath = join(dir, "workflow.yaml");
    writeFileSync(filePath, `plan:
  type: plan
  agent: developer
  on:
    completed: COMPLETE
    failed: ABORT
`, "utf-8");
    const wf = parseWorkflowInput(filePath);
    expect(wf.phases).toHaveLength(1);
    expect(wf.phases[0].name).toBe("plan");
  });

  it("test_rejects_invalid_yaml", () => {
    expect(() => parseWorkflowInput("{{invalid yaml")).toThrow();
  });

  it("test_rejects_invalid_workflow_structure", () => {
    expect(() => parseWorkflowInput('{"plan": {"type": "invalid", "agent": "dev", "on": {"completed": "COMPLETE"}}}')).toThrow("不正なフェーズタイプ");
  });
});

// ─── parseAcInput ───────────────────────────────────────────────────────────

describe("parseAcInput", () => {
  it("test_parses_json_object_array", () => {
    const ac = parseAcInput('[{"description":"条件1","done":false},{"description":"条件2","done":true}]');
    expect(ac).toHaveLength(2);
    expect(ac[0]).toEqual({ description: "条件1", done: false });
    expect(ac[1]).toEqual({ description: "条件2", done: true });
  });

  it("test_parses_json_string_array", () => {
    const ac = parseAcInput('["条件A","条件B","条件C"]');
    expect(ac).toHaveLength(3);
    expect(ac[0]).toEqual({ description: "条件A", done: false });
    expect(ac[1]).toEqual({ description: "条件B", done: false });
    expect(ac[2]).toEqual({ description: "条件C", done: false });
  });

  it("test_parses_yaml_string", () => {
    const yaml = `- description: 条件1
  done: false
- description: 条件2
  done: true`;
    const ac = parseAcInput(yaml);
    expect(ac).toHaveLength(2);
    expect(ac[0]).toEqual({ description: "条件1", done: false });
    expect(ac[1]).toEqual({ description: "条件2", done: true });
  });

  it("test_parses_mixed_string_and_object", () => {
    const ac = parseAcInput('["シンプル条件",{"description":"詳細条件","done":true}]');
    expect(ac).toHaveLength(2);
    expect(ac[0]).toEqual({ description: "シンプル条件", done: false });
    expect(ac[1]).toEqual({ description: "詳細条件", done: true });
  });

  it("test_parses_file_path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsquad-ac-input-"));
    const filePath = join(dir, "ac.yaml");
    writeFileSync(filePath, `- description: ファイル条件1
  done: false
- description: ファイル条件2
  done: false
`, "utf-8");
    const ac = parseAcInput(filePath);
    expect(ac).toHaveLength(2);
    expect(ac[0].description).toBe("ファイル条件1");
  });

  it("test_rejects_non_array", () => {
    expect(() => parseAcInput('{"description":"条件"}')).toThrow("配列で指定");
  });

  it("test_rejects_invalid_element", () => {
    expect(() => parseAcInput('[{"done":true}]')).toThrow("Acceptance Criteria[0]");
  });

  it("test_rejects_invalid_yaml", () => {
    expect(() => parseAcInput("{{invalid")).toThrow();
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
    cmdTransition(ctx, "J000001", "approved", "LGTM");
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

// ─── cmdTransition (approve / reject) ───────────────────────────────────────

describe("cmdTransition (approve)", () => {
  it("test_approve_reviewer_phase_completes_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "approved", "LGTM");
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.status).toBe("completed");
  });

  it("test_approve_rejects_non_reviewer_phase", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    expect(() => cmdTransition(ctx, "J000001", "approved", "")).toThrow("通常フェーズ");
  });
});

describe("cmdTransition (reject)", () => {
  it("test_reject_reviewer_phase_goes_back_to_code", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "completed", "");
    cmdTransition(ctx, "J000001", "rejected", "テスト不足");
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
    cmdAdd(ctx, "テストタスク", WORKFLOW);
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

  it("test_list_exclude_status_filters_jobs", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    ctx.jobStore.save(makeJob("J000002", "completed"));
    ctx.jobStore.save(makeJob("J000003", "running"));
    const lines = captureLog(() => cmdList(ctx, { excludeStatus: "completed" }));
    expect(lines.some((l) => l.includes("J000001"))).toBe(true);
    expect(lines.some((l) => l.includes("J000002"))).toBe(false);
    expect(lines.some((l) => l.includes("J000003"))).toBe(true);
  });

  it("test_list_exclude_status_multiple_statuses", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    ctx.jobStore.save(makeJob("J000002", "completed"));
    ctx.jobStore.save(makeJob("J000003", "aborted"));
    const lines = captureLog(() => cmdList(ctx, { excludeStatus: "completed,aborted" }));
    expect(lines.some((l) => l.includes("J000001"))).toBe(true);
    expect(lines.some((l) => l.includes("J000002"))).toBe(false);
    expect(lines.some((l) => l.includes("J000003"))).toBe(false);
  });

  it("test_list_exclude_status_all_filtered_shows_empty_message", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));
    const lines = captureLog(() => cmdList(ctx, { excludeStatus: "completed" }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("ジョブはありません。");
  });

  it("test_list_exclude_status_invalid_throws_error", () => {
    const { ctx } = setup();
    expect(() => cmdList(ctx, { excludeStatus: "invalid" })).toThrow("不正なステータス: invalid");
  });

  it("test_list_json_format_outputs_valid_json", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    ctx.jobStore.save(makeJob("J000002", "running"));
    const lines = captureLog(() => cmdList(ctx, { format: "json" }));
    const output = JSON.parse(lines.join("\n"));
    expect(output).toHaveLength(2);
    expect(output[0].id).toBe("J000001");
    expect(output[0].status).toBe("pending");
    expect(output[1].id).toBe("J000002");
    expect(output[1].status).toBe("running");
  });

  it("test_list_json_format_empty_outputs_empty_array", () => {
    const { ctx } = setup();
    const lines = captureLog(() => cmdList(ctx, { format: "json" }));
    const output = JSON.parse(lines.join("\n"));
    expect(output).toEqual([]);
  });

  it("test_list_json_format_with_exclude_status", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    ctx.jobStore.save(makeJob("J000002", "completed"));
    const lines = captureLog(() => cmdList(ctx, { format: "json", excludeStatus: "completed" }));
    const output = JSON.parse(lines.join("\n"));
    expect(output).toHaveLength(1);
    expect(output[0].id).toBe("J000001");
  });

  it("test_list_json_format_includes_all_fields", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    const lines = captureLog(() => cmdList(ctx, { format: "json" }));
    const output = JSON.parse(lines.join("\n"));
    const job = output[0];
    expect(job).toHaveProperty("id");
    expect(job).toHaveProperty("title");
    expect(job).toHaveProperty("status");
    expect(job).toHaveProperty("current_phase");
    expect(job).toHaveProperty("iteration");
    expect(job).toHaveProperty("max_iterations");
    expect(job).toHaveProperty("priority");
    expect(job).toHaveProperty("depends_on");
    expect(job).toHaveProperty("created_at");
    expect(job).toHaveProperty("updated_at");
  });
});

// ─── cmdShow ─────────────────────────────────────────────────────────────────

describe("cmdShow", () => {
  it("test_show_text_format_displays_job_details", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "表示テスト", WORKFLOW);
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

// ─── cmdUpdate (workflow) ───────────────────────────────────────────────────

const NEW_PHASES = "plan:plan:planner,code:execute:coder,test:execute:tester,review:review:reviewer";
const NEW_TRANSITIONS = "plan:completed>code,plan:failed>ABORT,code:completed>test,code:failed>plan,test:completed>review,test:failed>code,review:approved>COMPLETE,review:rejected>code";

describe("cmdUpdate workflow", () => {
  it("test_update_workflow_on_pending_job", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", WORKFLOW);
    const workflowConfig = buildWorkflowConfig(NEW_PHASES, NEW_TRANSITIONS);
    cmdUpdate(ctx, "J000001", { workflowConfig });
    const job = ctx.jobStore.load("J000001");
    const wf = job.frontmatter.workflow;
    expect(wf.phases.find(p => p.agent === "planner")).toBeDefined();
    expect(wf.phases.find(p => p.agent === "coder")).toBeDefined();
    expect(wf.phases.find(p => p.agent === "tester")).toBeDefined();
    expect(wf.phases.find(p => p.agent === "reviewer")).toBeDefined();
    // 古い定義が残っていない
    expect(wf.phases.find(p => p.agent === "developer")).toBeUndefined();
  });

  it("test_update_workflow_rejects_running_job", () => {
    const { ctx } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    cmdRun(ctx, "J000001");
    const workflowConfig = buildWorkflowConfig(NEW_PHASES, NEW_TRANSITIONS);
    expect(() => cmdUpdate(ctx, "J000001", { workflowConfig })).toThrow("pending 状態でない");
  });

  it("test_update_workflow_with_title_updates_both", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "旧タイトル", WORKFLOW);
    const workflowConfig = buildWorkflowConfig(NEW_PHASES, NEW_TRANSITIONS);
    cmdUpdate(ctx, "J000001", { title: "新タイトル", workflowConfig });
    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.title).toBe("新タイトル");
    expect(job.frontmatter.workflow.phases.find(p => p.agent === "tester")).toBeDefined();
  });

  it("test_update_workflow_preserves_description_section", () => {
    const { ctx } = setup();
    cmdAdd(ctx, "タスク", WORKFLOW, "重要な説明文");
    const workflowConfig = buildWorkflowConfig(NEW_PHASES, NEW_TRANSITIONS);
    cmdUpdate(ctx, "J000001", { workflowConfig });
    const job = ctx.jobStore.load("J000001");
    expect(job.body).toContain("重要な説明文");
    expect(job.frontmatter.workflow.phases.find(p => p.agent === "tester")).toBeDefined();
    // 古い agent 定義が残っていないこと
    expect(job.frontmatter.workflow.phases.find(p => p.agent === "developer")).toBeUndefined();
  });
});
