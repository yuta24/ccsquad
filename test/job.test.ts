import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/infra/job-store.js";
import type { Job, JobFrontmatter, WorkflowConfig } from "../src/domain/types.js";

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

  it("createWithNextId は作成直前に ID が競合した場合に次の ID で再試行する", () => {
    const store = makeTempStore();
    let injectedRace = false;

    const created = store.createWithNextId(
      (id) => makeJob(id, "created"),
      (id) => {
        if (id === "J000001" && !injectedRace) {
          injectedRace = true;
          store.save(makeJob("J000001", "racer"));
        }
      },
    );

    expect(created.frontmatter.id).toBe("J000002");
    expect(store.load("J000001").frontmatter.title).toBe("racer");
    expect(store.load("J000002").frontmatter.title).toBe("created");
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

  it("不正なジョブ ID はパスとして扱わずエラー", () => {
    const store = makeTempStore();
    expect(() => store.load("../J000001")).toThrow(/不正なジョブ ID/);
  });

  it("frontmatter の id がファイル名と違う場合はエラー", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccsquad-job-test-"));
    const store = new JobStore(dir);
    store.ensureDir();
    const job = makeJob("J000002", "mismatch");
    const yaml = [
      "---",
      "id: J000002",
      "title: mismatch",
      "status: pending",
      "iteration: 0",
      "max_iterations: 10",
      "workflow:",
      "  plan:",
      "    type: plan",
      "    agent: developer",
      "    on:",
      "      completed: COMPLETE",
      "      failed: ABORT",
      `created_at: "${job.frontmatter.created_at}"`,
      `updated_at: "${job.frontmatter.updated_at}"`,
      "---",
      "",
    ].join("\n");
    writeFileSync(join(dir, "J000001.md"), yaml, "utf-8");

    expect(() => store.load("J000001")).toThrow(/ファイル名 'J000001' と一致しません/);
  });
});
