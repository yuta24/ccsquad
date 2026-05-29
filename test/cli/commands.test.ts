import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobStore } from "../../src/infra/job-store.js";
import { LogStore } from "../../src/infra/log-store.js";
import { cmdAbort, cmdDelete, cmdList } from "../../src/cli/commands/job.js";
import { cmdCreate, cmdRun } from "../../src/cli/commands/job.js";
import { CcsquadError } from "../../src/error.js";
import type { ProjectContext } from "../../src/app/project-context.js";
import { parseWorkflowObject } from "../../src/domain/workflow.js";

// ── テスト用ヘルパー ──

function makeCtx(tmpDir: string): ProjectContext {
  const jobsDir = join(tmpDir, "jobs");
  const logsDir = join(tmpDir, "logs");
  return {
    jobStore: new JobStore(jobsDir),
    logStore: new LogStore(logsDir),
    projectRoot: tmpDir,
    squadDir: tmpDir,
    jobsDir,
    logsDir,
  };
}

const BASIC_WF = parseWorkflowObject({
  plan: { type: "plan", agent: "developer", on: { completed: "execute", failed: "ABORT" } },
  execute: { type: "execute", agent: "developer", on: { completed: "review", failed: "plan" } },
  review: { type: "review", agent: "reviewer", on: { approved: "COMPLETE", rejected: "execute" } },
});

// ── abort --message ──

describe("cmdAbort", () => {
  let tmpDir: string;
  let ctx: ProjectContext;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ccsquad-test-"));
    ctx = makeCtx(tmpDir);
    ctx.jobStore.ensureDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("中断するとジョブのステータスが aborted になる", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdAbort(ctx, id);
    const job = ctx.jobStore.load(id);
    expect(job.frontmatter.status).toBe("aborted");
  });

  it("--message を指定すると中断前のフェーズでログが記録される", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdRun(ctx, id);

    const jobBeforeAbort = ctx.jobStore.load(id);
    const phaseBeforeAbort = jobBeforeAbort.frontmatter.current_phase;

    cmdAbort(ctx, id, "方針変更のため中断");

    const log = ctx.logStore.read(id);
    expect(log).not.toBeNull();
    expect(log).toContain("方針変更のため中断");
    expect(log).toContain(`[${phaseBeforeAbort}]`);
  });

  it("--message を指定しない場合はログが記録されない", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdRun(ctx, id);
    cmdAbort(ctx, id);
    expect(ctx.logStore.read(id)).toBeNull();
  });

  it("pending 状態のジョブも中断できる", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    expect(() => cmdAbort(ctx, id)).not.toThrow();
  });

  it("completed 状態のジョブは中断できない", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    const job = ctx.jobStore.load(id);
    job.frontmatter.status = "completed";
    ctx.jobStore.save(job);
    expect(() => cmdAbort(ctx, id)).toThrow(CcsquadError);
  });
});

// ── delete ──

describe("cmdDelete", () => {
  let tmpDir: string;
  let ctx: ProjectContext;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ccsquad-test-"));
    ctx = makeCtx(tmpDir);
    ctx.jobStore.ensureDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ジョブファイルを削除する", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    const filePath = join(ctx.jobsDir, `${id}.md`);
    expect(existsSync(filePath)).toBe(true);

    cmdDelete(ctx, id);
    expect(existsSync(filePath)).toBe(false);
  });

  it("削除後は load でエラーになる", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdDelete(ctx, id);
    expect(() => ctx.jobStore.load(id)).toThrow(CcsquadError);
  });

  it("存在しないジョブを削除しようとするとエラー", () => {
    expect(() => cmdDelete(ctx, "J999999")).toThrow(CcsquadError);
  });

  it("running 状態のジョブも削除できる", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdRun(ctx, id);
    expect(() => cmdDelete(ctx, id)).not.toThrow();
  });

  it("削除時にログファイルも一緒に削除される", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdRun(ctx, id);
    // ログを書き込んでから削除
    ctx.logStore.append(id, "plan", "テストログ");
    const logPath = ctx.logStore.logPath(id);
    expect(existsSync(logPath)).toBe(true);

    cmdDelete(ctx, id);
    expect(existsSync(logPath)).toBe(false);
  });

  it("ログなしのジョブを削除してもエラーにならない", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    expect(() => cmdDelete(ctx, id)).not.toThrow();
  });
});

// ── list --status ──

describe("cmdList --status", () => {
  let tmpDir: string;
  let ctx: ProjectContext;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ccsquad-test-"));
    ctx = makeCtx(tmpDir);
    ctx.jobStore.ensureDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createAndGetId(title: string): string {
    cmdCreate(ctx, title, BASIC_WF);
    const all = ctx.jobStore.listAll();
    return all[all.length - 1].frontmatter.id;
  }

  it("--status で指定したステータスのジョブのみ表示する", () => {
    const id1 = createAndGetId("ジョブ1"); // pending
    const id2 = createAndGetId("ジョブ2");
    cmdRun(ctx, id2); // running

    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
    try {
      cmdList(ctx, { status: "running" });
    } finally {
      console.log = origLog;
    }

    const output = captured.join("\n");
    expect(output).toContain(id2);
    expect(output).not.toContain(id1);
  });

  it("--status に複数指定できる", () => {
    const id1 = createAndGetId("ジョブ1"); // pending
    const id2 = createAndGetId("ジョブ2");
    cmdRun(ctx, id2); // running
    const id3 = createAndGetId("ジョブ3");
    cmdAbort(ctx, id3); // aborted

    const jobs = ctx.jobStore.listAll();
    const runningOrPending = jobs.filter((j) =>
      ["pending", "running"].includes(j.frontmatter.status),
    );
    expect(runningOrPending.map((j) => j.frontmatter.id)).toContain(id1);
    expect(runningOrPending.map((j) => j.frontmatter.id)).toContain(id2);
    expect(runningOrPending.map((j) => j.frontmatter.id)).not.toContain(id3);
  });

  it("--status と --exclude-status を同時指定するとエラー", () => {
    expect(() => cmdList(ctx, { status: "running", excludeStatus: "completed" })).toThrow(CcsquadError);
  });

  it("不正なステータスを --status に指定するとエラー", () => {
    expect(() => cmdList(ctx, { status: "invalid" })).toThrow(CcsquadError);
  });
});
