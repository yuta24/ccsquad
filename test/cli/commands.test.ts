import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobStore } from "../../src/infra/job-store.js";
import { LogStore } from "../../src/infra/log-store.js";
import { PlanStore } from "../../src/infra/plan-store.js";
import { cmdAbort, cmdDelete, cmdList, cmdShowLog } from "../../src/cli/commands/job.js";
import { cmdCreate, cmdRun, cmdDone } from "../../src/cli/commands/job.js";
import { CcsquadError } from "../../src/error.js";
import type { ProjectContext } from "../../src/app/project-context.js";
import { parseWorkflowObject } from "../../src/domain/workflow.js";

// ── テスト用ヘルパー ──

function makeCtx(tmpDir: string): ProjectContext {
  const jobsDir = join(tmpDir, "jobs");
  const logsDir = join(tmpDir, "logs");
  const plansDir = join(tmpDir, "plans");
  return {
    jobStore: new JobStore(jobsDir),
    logStore: new LogStore(logsDir),
    planStore: new PlanStore(plansDir),
    projectRoot: tmpDir,
    squadDir: tmpDir,
    jobsDir,
    logsDir,
    plansDir,
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

  it("running 状態のジョブは --force なしでエラー", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdRun(ctx, id);
    expect(() => cmdDelete(ctx, id)).toThrow(CcsquadError);
  });

  it("running 状態のジョブも --force で削除できる", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdRun(ctx, id);
    expect(() => cmdDelete(ctx, id, { force: true })).not.toThrow();
  });

  it("削除時にログファイルも一緒に削除される", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdRun(ctx, id);
    // ログを書き込んでから削除
    ctx.logStore.append(id, "plan", "テストログ");
    const logPath = ctx.logStore.logPath(id);
    expect(existsSync(logPath)).toBe(true);

    cmdDelete(ctx, id, { force: true });
    expect(existsSync(logPath)).toBe(false);
  });

  it("ログなしのジョブを削除してもエラーにならない", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    expect(() => cmdDelete(ctx, id)).not.toThrow();
  });

  it("他ジョブから depends_on 参照されているジョブは削除できない", () => {
    cmdCreate(ctx, "ジョブ1", BASIC_WF);
    const id1 = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdCreate(ctx, "ジョブ2", BASIC_WF, undefined, [id1]);
    expect(() => cmdDelete(ctx, id1)).toThrow(CcsquadError);
  });

  it("depends_on 参照ジョブを削除した後は参照元を削除できる", () => {
    cmdCreate(ctx, "ジョブ1", BASIC_WF);
    const id1 = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdCreate(ctx, "ジョブ2", BASIC_WF, undefined, [id1]);
    const id2 = ctx.jobStore.listAll()[1].frontmatter.id;
    cmdDelete(ctx, id2); // 参照元を先に削除
    expect(() => cmdDelete(ctx, id1)).not.toThrow();
  });

  it("--force で参照元があっても強制削除できる", () => {
    cmdCreate(ctx, "ジョブ1", BASIC_WF);
    const id1 = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdCreate(ctx, "ジョブ2", BASIC_WF, undefined, [id1]);
    expect(() => cmdDelete(ctx, id1, { force: true })).not.toThrow();
    expect(() => ctx.jobStore.load(id1)).toThrow(CcsquadError);
  });

  it("paused 状態のジョブは --force なしでエラー", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdRun(ctx, id);
    const job = ctx.jobStore.load(id);
    job.frontmatter.status = "paused";
    job.frontmatter.pause_reason = "human_review";
    ctx.jobStore.save(job);
    expect(() => cmdDelete(ctx, id)).toThrow(CcsquadError);
  });

  it("paused 状態のジョブも --force で削除できる", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    cmdRun(ctx, id);
    const job = ctx.jobStore.load(id);
    job.frontmatter.status = "paused";
    job.frontmatter.pause_reason = "human_review";
    ctx.jobStore.save(job);
    expect(() => cmdDelete(ctx, id, { force: true })).not.toThrow();
  });
});

// ── log ──

describe("cmdShowLog", () => {
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

  it("ログがある場合は内容を出力する", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    ctx.logStore.append(id, "plan", "計画フェーズのログ");

    const written: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => { written.push(String(chunk)); return true; };
    try {
      cmdShowLog(ctx, id);
    } finally {
      process.stdout.write = orig;
    }

    const output = written.join("");
    expect(output).toContain("計画フェーズのログ");
    expect(output).toContain("[plan]");
  });

  it("ログがない場合は stderr に案内を出す", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;

    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => { written.push(String(chunk)); return true; };
    try {
      cmdShowLog(ctx, id);
    } finally {
      process.stderr.write = orig;
    }

    expect(written.join("")).toContain("ログはありません");
  });

  it("存在しないジョブ ID を指定するとエラー", () => {
    expect(() => cmdShowLog(ctx, "J999999")).toThrow(CcsquadError);
  });

  it("空のログファイルがある場合は stdout に空文字列を出力し 'ログはありません' とは言わない", () => {
    cmdCreate(ctx, "テスト", BASIC_WF);
    const id = ctx.jobStore.listAll()[0].frontmatter.id;
    mkdirSync(ctx.logsDir, { recursive: true });
    writeFileSync(join(ctx.logsDir, `${id}.md`), "");

    const stdoutWritten: string[] = [];
    const stderrWritten: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: unknown) => { stdoutWritten.push(String(chunk)); return true; };
    process.stderr.write = (chunk: unknown) => { stderrWritten.push(String(chunk)); return true; };
    try {
      cmdShowLog(ctx, id);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }

    expect(stderrWritten.join("")).not.toContain("ログはありません");
    expect(stdoutWritten.join("")).toBe("");
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
