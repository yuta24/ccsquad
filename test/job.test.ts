import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/infra/job-store.js";
import type { Job, JobFrontmatter, WorkflowConfig } from "../src/domain/types.js";
import { buildPhaseLogEntry } from "../src/domain/phase-log.js";
import { PhaseLogStore } from "../src/infra/phase-log-store.js";

const WORKFLOW: WorkflowConfig = {
  phases: [
    { name: "plan", type: "plan", agent: "developer", on: { completed: "code", failed: "ABORT" } },
    { name: "code", type: "execute", agent: "developer", on: { completed: "COMPLETE", failed: "plan" } },
  ],
};

function makeTempStore(): JobStore {
  const dir = mkdtempSync(join(tmpdir(), "ccsquad-job-test-"));
  const store = new JobStore(dir);
  store.ensureDir();
  return store;
}

function makeJob(id: string, title: string): Job {
  const now = new Date().toISOString();
  const frontmatter: JobFrontmatter = {
    id,
    title,
    status: "pending",
    iteration: 0,
    max_iterations: 10,
    priority: 0,
    depends_on: [],
    acceptance_criteria: [],
    workflow: WORKFLOW,
    created_at: now,
    updated_at: now,
  };
  return {
    frontmatter,
    body: "## 説明\nテストジョブです。\n",
  };
}

describe("JobStore", () => {
  it("保存と読み込み", () => {
    const store = makeTempStore();
    const job = makeJob("J000001", "テスト");
    store.save(job);
    const loaded = store.load("J000001");
    expect(loaded.frontmatter.id).toBe("J000001");
    expect(loaded.frontmatter.title).toBe("テスト");
    expect(loaded.frontmatter.status).toBe("pending");
    expect(loaded.body).toContain("テストジョブです");
  });

  it("ワークフローが frontmatter に保存される", () => {
    const store = makeTempStore();
    const job = makeJob("J000001", "テスト");
    store.save(job);
    const loaded = store.load("J000001");
    expect(loaded.frontmatter.workflow.phases).toHaveLength(2);
    expect(loaded.frontmatter.workflow.phases[0].name).toBe("plan");
    expect(loaded.frontmatter.workflow.phases[0].agent).toBe("developer");
    expect(loaded.frontmatter.workflow.phases[1].name).toBe("code");
  });

  it("空ディレクトリでJ000001", () => {
    const store = makeTempStore();
    expect(store.nextId()).toBe("J000001");
  });

  it("IDがインクリメントされる", () => {
    const store = makeTempStore();
    store.save(makeJob("J000001", "a"));
    store.save(makeJob("J000003", "b"));
    expect(store.nextId()).toBe("J000004");
  });

  it("全ジョブ一覧（ID昇順）", () => {
    const store = makeTempStore();
    store.save(makeJob("J000001", "a"));
    store.save(makeJob("J000002", "b"));
    const jobs = store.listAll();
    expect(jobs.length).toBe(2);
    expect(jobs[0].frontmatter.id).toBe("J000001");
    expect(jobs[1].frontmatter.id).toBe("J000002");
  });

  it("削除", () => {
    const store = makeTempStore();
    store.save(makeJob("J000001", "a"));
    store.delete("J000001");
    expect(() => store.load("J000001")).toThrow();
  });

  it("存在しないジョブでエラー", () => {
    const store = makeTempStore();
    expect(() => store.load("J999999")).toThrow();
  });
});

describe("PhaseLogStore", () => {
  function makeTempLogStore(): PhaseLogStore {
    const dir = mkdtempSync(join(tmpdir(), "ccsquad-phaselog-test-"));
    return new PhaseLogStore(dir);
  }

  it("ログ追記と読み込み", () => {
    const store = makeTempLogStore();
    const entry = buildPhaseLogEntry("plan", "completed", "code", "計画完了");
    store.append("J000001", entry);
    const content = store.read("J000001");
    expect(content).toContain("### plan (completed → code)");
    expect(content).toContain("計画完了");
  });

  it("複数エントリの追記", () => {
    const store = makeTempLogStore();
    const entry1 = buildPhaseLogEntry("plan", "completed", "code", "計画完了");
    const entry2 = buildPhaseLogEntry("code", "completed", "review", "実装完了");
    store.append("J000001", entry1);
    store.append("J000001", entry2);
    const content = store.read("J000001");
    const logCount = (content.match(/###/g) ?? []).length;
    expect(logCount).toBe(2);
  });

  it("存在しないジョブのログは空文字列", () => {
    const store = makeTempLogStore();
    expect(store.read("J999999")).toBe("");
  });

  it("空メッセージ", () => {
    const store = makeTempLogStore();
    const entry = buildPhaseLogEntry("plan", "completed", "code", "");
    store.append("J000001", entry);
    const content = store.read("J000001");
    expect(content).toContain("### plan (completed → code)");
  });
});
