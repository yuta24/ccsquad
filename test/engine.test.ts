import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStatus, Job } from "../src/domain/types.js";
import { JobStore } from "../src/infra/job-store.js";
import { JobService, checkCircularDependency } from "../src/app/job-service.js";
import type { ProjectContext } from "../src/app/project-context.js";
import { createTestContext } from "./helpers.js";

const DEV_WORKFLOW_BODY = `## Acceptance Criteria

- [ ] テスト基準

## Workflow

- plan: plan -> completed:code, failed:ABORT
- code: execute -> completed:review, failed:plan
- review: review -> approved:COMPLETE, rejected:code
`;

const DEV_WORKFLOW_BODY_NO_AC = `## Workflow

- plan: plan -> completed:code, failed:ABORT
- code: execute -> completed:review, failed:plan
- review: review -> approved:COMPLETE, rejected:code
`;

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
    body: DEV_WORKFLOW_BODY,
  };
}

function setup(): { ctx: ProjectContext; jobService: JobService } {
  const ctx = createTestContext("ccsquad-engine-test-");
  const jobService = new JobService(ctx);
  return { ctx, jobService };
}

describe("JobService (replaces WorkflowEngine)", () => {
  it("test_linear_workflow", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));

    const job = jobService.start("J000001");
    expect(job.frontmatter.status).toBe("running");
    expect(job.frontmatter.current_phase).toBe("plan");

    // plan -> completed -> code
    const result2 = jobService.transition("J000001", "completed", "計画完了");
    expect(result2.type).toBe("continue");
    if (result2.type === "continue") expect(result2.nextPhase).toBe("code");

    // code -> completed -> review (human_review pause)
    const result3 = jobService.transition("J000001", "completed", "実装完了");
    expect(result3.type).toBe("pause");
    if (result3.type === "pause") expect(result3.nextPhase).toBe("review");

    // review -> approved -> COMPLETE
    const result4 = jobService.transition("J000001", "approved", "LGTM");
    expect(result4.type).toBe("done");
    if (result4.type === "done") expect(result4.status).toBe("completed");

    const finalJob = ctx.jobStore.load("J000001");
    expect(finalJob.frontmatter.status).toBe("completed");
    expect(finalJob.frontmatter.current_phase).toBeUndefined();
  });

  it("test_loop_workflow", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    jobService.start("J000001");
    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");

    // review -> rejected -> code
    const result = jobService.transition("J000001", "rejected", "テスト不足");
    expect(result.type).toBe("continue");
    if (result.type === "continue") expect(result.nextPhase).toBe("code");

    // code -> completed -> review
    const result2 = jobService.transition("J000001", "completed", "修正完了");
    expect(result2.type).toBe("pause");
    if (result2.type === "pause") expect(result2.nextPhase).toBe("review");

    const result3 = jobService.transition("J000001", "approved", "OK");
    expect(result3.type).toBe("done");
    if (result3.type === "done") expect(result3.status).toBe("completed");
  });

  it("test_failure_fallback", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    jobService.start("J000001");
    jobService.transition("J000001", "completed", "");

    // code -> failed -> plan
    const result = jobService.transition("J000001", "failed", "ビルドエラー");
    expect(result.type).toBe("continue");
    if (result.type === "continue") expect(result.nextPhase).toBe("plan");
  });

  it("test_abort_to_failed", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    jobService.start("J000001");

    // plan -> failed -> ABORT
    const result = jobService.transition("J000001", "failed", "");
    expect(result.type).toBe("done");
    if (result.type === "done") expect(result.status).toBe("failed");

    const job = ctx.jobStore.load("J000001");
    expect(job.frontmatter.status).toBe("failed");
    expect(job.frontmatter.current_phase).toBeUndefined();
  });

  it("test_reviewer_phase_rejects_transition", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    jobService.start("J000001");
    jobService.transition("J000001", "completed", "");
    jobService.transition("J000001", "completed", "");

    expect(() => jobService.transition("J000001", "completed", "")).toThrow("approved/rejected");
  });

  it("test_non_reviewer_phase_rejects_approve", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    jobService.start("J000001");

    expect(() => jobService.transition("J000001", "approved", "")).toThrow("通常フェーズ");
  });

  it("test_non_reviewer_phase_rejects_reject", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    jobService.start("J000001");

    expect(() => jobService.transition("J000001", "rejected", "ダメ")).toThrow();
  });

  it("test_no_matching_rule", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    jobService.start("J000001");
    jobService.transition("J000001", "completed", "");

    expect(() => jobService.transition("J000001", "rejected", "")).toThrow("通常フェーズ");
  });

  it("test_completed_job_cannot_restart", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));

    expect(() => jobService.start("J000001")).toThrow();
  });

  it("test_depends_on_blocks_start", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "running"));

    const job2 = makeJob("J000002", "pending");
    job2.frontmatter.depends_on = ["J000001"];
    ctx.jobStore.save(job2);

    expect(() => jobService.start("J000002")).toThrow("未完了");
  });

  it("test_depends_on_allows_start_when_completed", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));

    const job2 = makeJob("J000002", "pending");
    job2.frontmatter.depends_on = ["J000001"];
    ctx.jobStore.save(job2);

    const job = jobService.start("J000002");
    expect(job.frontmatter.status).toBe("running");
  });

  it("test_abort_running_job", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    jobService.start("J000001");

    const job = jobService.abort("J000001");
    expect(job.frontmatter.status).toBe("aborted");
    expect(job.frontmatter.current_phase).toBeUndefined();
    expect(job.body).toContain("手動中断");
  });

  it("test_abort_pending_job", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));

    const job = jobService.abort("J000001");
    expect(job.frontmatter.status).toBe("aborted");
  });

  it("test_iteration_increments_on_continue", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    jobService.start("J000001");

    expect(ctx.jobStore.load("J000001").frontmatter.iteration).toBe(0);

    jobService.transition("J000001", "completed", "");

    expect(ctx.jobStore.load("J000001").frontmatter.iteration).toBe(1);
  });

  it("test_transition_to_execute_without_ac_throws", () => {
    const { ctx, jobService } = setup();
    const job = makeJob("J000001", "pending");
    job.body = DEV_WORKFLOW_BODY_NO_AC;
    ctx.jobStore.save(job);
    jobService.start("J000001");

    // plan -> completed -> code should fail without AC
    expect(() => jobService.transition("J000001", "completed", "計画完了")).toThrow("Acceptance Criteria");
  });

  it("test_transition_to_execute_with_ac_succeeds", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    jobService.start("J000001");

    // plan -> completed -> code should succeed with AC
    const result = jobService.transition("J000001", "completed", "計画完了");
    expect(result.type).toBe("continue");
    if (result.type === "continue") expect(result.nextPhase).toBe("code");
  });

  it("test_abort_resets_iteration", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    jobService.start("J000001");
    jobService.transition("J000001", "completed", "");
    expect(ctx.jobStore.load("J000001").frontmatter.iteration).toBe(1);

    jobService.abort("J000001");
    expect(ctx.jobStore.load("J000001").frontmatter.iteration).toBe(0);
  });
});

describe("JobService.getStatus", () => {
  it("pending ジョブのステータスを返す", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));

    const result = jobService.getStatus("J000001");
    expect(result.status).toBe("pending");
    expect(result.currentPhase).toBeUndefined();
  });

  it("running ジョブのステータスとフェーズを返す", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "pending"));
    jobService.start("J000001");

    const result = jobService.getStatus("J000001");
    expect(result.status).toBe("running");
    expect(result.currentPhase).toBe("plan");
  });

  it("completed ジョブのステータスを返す", () => {
    const { ctx, jobService } = setup();
    ctx.jobStore.save(makeJob("J000001", "completed"));

    const result = jobService.getStatus("J000001");
    expect(result.status).toBe("completed");
    expect(result.currentPhase).toBeUndefined();
  });
});

describe("checkCircularDependency", () => {
  it("test_circular_dependency_detection", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsquad-circ-test-"));
    const jobsDir = join(dir, "jobs");
    const store = new JobStore(jobsDir);
    store.ensureDir();

    const job1 = makeJob("J000001", "pending");
    job1.frontmatter.depends_on = ["J000002"];
    store.save(job1);

    const job2 = makeJob("J000002", "pending");
    job2.frontmatter.depends_on = ["J000001"];
    store.save(job2);

    const ctx = {
      jobStore: store,
    } as ProjectContext;

    expect(() => checkCircularDependency(ctx, "J000001", ["J000002"])).toThrow("循環依存");
  });

  it("test_no_circular_dependency", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsquad-circ-test-"));
    const jobsDir = join(dir, "jobs");
    const store = new JobStore(jobsDir);
    store.ensureDir();

    store.save(makeJob("J000001", "completed"));
    store.save(makeJob("J000002", "completed"));

    const ctx = {
      jobStore: store,
    } as ProjectContext;

    expect(() =>
      checkCircularDependency(ctx, "J000003", ["J000001", "J000002"]),
    ).not.toThrow();
  });
});
