import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SquadConfigImpl } from "../src/config.js";
import type { JobStatus } from "../src/job.js";
import type { Job } from "../src/job.js";
import { JobStore } from "../src/job.js";
import { WorkflowEngine, checkCircularDependency } from "../src/engine.js";

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

function makeJob(id: string, status: JobStatus): Job {
  const now = new Date().toISOString();
  return {
    frontmatter: {
      id,
      title: "テスト",
      workflow: "dev",
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
  const dir = mkdtempSync(join(tmpdir(), "ccsquad-engine-test-"));
  const store = new JobStore(dir);
  store.ensureDir();
  const config = SquadConfigImpl.parse(DEV_CONFIG_YAML);
  const wf = config.getWorkflow("dev")!;
  const engine = new WorkflowEngine(wf, store);
  return { store, engine };
}

describe("WorkflowEngine", () => {
  it("test_linear_workflow", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "pending"));

    const job = engine.startJob("J000001");
    expect(job.frontmatter.status).toBe("running");
    expect(job.frontmatter.current_phase).toBe("plan");

    // plan -> completed -> code
    const job2 = engine.transition("J000001", "completed", "計画完了");
    expect(job2.frontmatter.current_phase).toBe("code");

    // code -> completed -> review
    const job3 = engine.transition("J000001", "completed", "実装完了");
    expect(job3.frontmatter.current_phase).toBe("review");

    // review -> approved -> COMPLETE
    const job4 = engine.approve("J000001", "LGTM");
    expect(job4.frontmatter.status).toBe("completed");
    expect(job4.frontmatter.current_phase).toBeUndefined();
  });

  it("test_loop_workflow", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "pending"));
    engine.startJob("J000001");
    engine.transition("J000001", "completed", "");
    engine.transition("J000001", "completed", "");

    // review -> rejected -> code
    const job = engine.reject("J000001", "テスト不足");
    expect(job.frontmatter.current_phase).toBe("code");

    // code -> completed -> review
    const job2 = engine.transition("J000001", "completed", "修正完了");
    expect(job2.frontmatter.current_phase).toBe("review");

    const job3 = engine.approve("J000001", "OK");
    expect(job3.frontmatter.status).toBe("completed");
  });

  it("test_failure_fallback", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "pending"));
    engine.startJob("J000001");
    engine.transition("J000001", "completed", "");

    // code -> failed -> plan
    const job = engine.transition("J000001", "failed", "ビルドエラー");
    expect(job.frontmatter.current_phase).toBe("plan");
  });

  it("test_abort_to_failed", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "pending"));
    engine.startJob("J000001");

    // plan -> failed -> ABORT
    const job = engine.transition("J000001", "failed", "");
    expect(job.frontmatter.status).toBe("failed");
    expect(job.frontmatter.current_phase).toBeUndefined();
  });

  it("test_reviewer_phase_rejects_transition", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "pending"));
    engine.startJob("J000001");
    engine.transition("J000001", "completed", "");
    engine.transition("J000001", "completed", "");

    expect(() => engine.transition("J000001", "completed", "")).toThrow("approve/reject");
  });

  it("test_non_reviewer_phase_rejects_approve", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "pending"));
    engine.startJob("J000001");

    expect(() => engine.approve("J000001", "")).toThrow("レビュアー");
  });

  it("test_non_reviewer_phase_rejects_reject", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "pending"));
    engine.startJob("J000001");

    expect(() => engine.reject("J000001", "ダメ")).toThrow();
  });

  it("test_no_matching_rule", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "pending"));
    engine.startJob("J000001");
    engine.transition("J000001", "completed", "");

    expect(() => engine.transition("J000001", "rejected", "")).toThrow("ルールがありません");
  });

  it("test_completed_job_cannot_restart", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "completed"));

    expect(() => engine.startJob("J000001")).toThrow();
  });

  it("test_depends_on_blocks_start", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "running"));

    const job2 = makeJob("J000002", "pending");
    job2.frontmatter.depends_on = ["J000001"];
    store.save(job2);

    expect(() => engine.startJob("J000002")).toThrow("未完了");
  });

  it("test_depends_on_allows_start_when_completed", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "completed"));

    const job2 = makeJob("J000002", "pending");
    job2.frontmatter.depends_on = ["J000001"];
    store.save(job2);

    const job = engine.startJob("J000002");
    expect(job.frontmatter.status).toBe("running");
  });

  it("test_abort_running_job", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "pending"));
    engine.startJob("J000001");

    const job = engine.abortJob("J000001");
    expect(job.frontmatter.status).toBe("aborted");
    expect(job.frontmatter.current_phase).toBeUndefined();
    expect(job.body).toContain("手動中断");
  });

  it("test_abort_pending_job", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "pending"));

    const job = engine.abortJob("J000001");
    expect(job.frontmatter.status).toBe("aborted");
  });

  it("test_close_running_job", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "pending"));
    engine.startJob("J000001");

    const job = engine.closeJob("J000001");
    expect(job.frontmatter.status).toBe("closed");
    expect(job.frontmatter.current_phase).toBeUndefined();
    expect(job.body).toContain("手動クローズ");
  });

  it("test_close_pending_job", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "pending"));

    const job = engine.closeJob("J000001");
    expect(job.frontmatter.status).toBe("closed");
  });

  it("test_close_failed_job", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "failed"));

    const job = engine.closeJob("J000001");
    expect(job.frontmatter.status).toBe("closed");
  });

  it("test_close_aborted_job", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "aborted"));

    const job = engine.closeJob("J000001");
    expect(job.frontmatter.status).toBe("closed");
  });

  it("test_close_completed_job", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "completed"));

    const job = engine.closeJob("J000001");
    expect(job.frontmatter.status).toBe("closed");
  });

  it("test_close_already_closed_job_returns_error", () => {
    const { store, engine } = setup();
    store.save(makeJob("J000001", "closed"));

    expect(() => engine.closeJob("J000001")).toThrow("既にクローズ");
  });
});

describe("checkCircularDependency", () => {
  it("test_circular_dependency_detection", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsquad-circ-test-"));
    const store = new JobStore(dir);
    store.ensureDir();

    const job1 = makeJob("J000001", "pending");
    job1.frontmatter.depends_on = ["J000002"];
    store.save(job1);

    const job2 = makeJob("J000002", "pending");
    job2.frontmatter.depends_on = ["J000001"];
    store.save(job2);

    expect(() => checkCircularDependency(store, "J000001", ["J000002"])).toThrow("循環依存");
  });

  it("test_no_circular_dependency", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsquad-circ-test-"));
    const store = new JobStore(dir);
    store.ensureDir();

    store.save(makeJob("J000001", "completed"));
    store.save(makeJob("J000002", "completed"));

    expect(() =>
      checkCircularDependency(store, "J000003", ["J000001", "J000002"]),
    ).not.toThrow();
  });
});
