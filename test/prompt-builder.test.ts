import { describe, expect, test } from "bun:test";
import { buildJobPrompt } from "../src/app/prompt-builder.js";
import type { Job } from "../src/domain/types.js";

function makeJob(id: string, overrides: Partial<Job["frontmatter"]> = {}): Job {
  return {
    frontmatter: {
      id,
      title: "テストジョブ",
      status: "running",
      current_phase: "execute",
      iteration: 0,
      max_iterations: 10,

      depends_on: [],
      acceptance_criteria: [],
      workflow: {
        phases: [
          { name: "execute", type: "execute", agent: "developer", on: { completed: "COMPLETE", failed: "ABORT" } },
        ],
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    },
    body: "",
  };
}

describe("buildJobPrompt", () => {
  test("includes job ID in prompt", () => {
    const prompt = buildJobPrompt(makeJob("J000042"), null);
    expect(prompt).toContain("J000042");
  });

  test("includes ccsquad done commands with job ID", () => {
    const prompt = buildJobPrompt(makeJob("J000001"), null);
    expect(prompt).toContain("ccsquad done J000001 completed");
    expect(prompt).toContain("ccsquad done J000001 failed");
  });

  test("includes autonomous execution protocol", () => {
    const prompt = buildJobPrompt(makeJob("J000001"), null);
    expect(prompt).toContain("自律実行プロトコル");
    expect(prompt).toContain("必ず現在フェーズに対応する ccsquad done コマンドを実行する");
    expect(prompt).toContain("人間レビューが必要な指示が出ている場合は ccsquad done を実行せず");
  });

  test("static block contains title and body", () => {
    const job = makeJob("J000001");
    job.body = "## 詳細\nこれはテスト用のジョブ内容です。";
    const prompt = buildJobPrompt(job, null);
    expect(prompt).toContain("<static>");
    expect(prompt).toContain("</static>");
    expect(prompt).toContain("テストジョブ");
    expect(prompt).toContain("これはテスト用のジョブ内容です。");
  });

  test("dynamic block contains phase and iteration", () => {
    const prompt = buildJobPrompt(makeJob("J000001"), null);
    expect(prompt).toContain("<dynamic>");
    expect(prompt).toContain("</dynamic>");
    expect(prompt).toContain("execute");
    expect(prompt).toContain("0/10");
  });

  test("includes acceptance criteria", () => {
    const job = makeJob("J000001", {
      acceptance_criteria: [
        { description: "テストが通ること", done: true },
        { description: "型エラーがないこと", done: false },
      ],
    });
    const prompt = buildJobPrompt(job, null);
    expect(prompt).toContain("[x] テストが通ること");
    expect(prompt).toContain("[ ] 型エラーがないこと");
  });

  test("includes log content when provided", () => {
    const logContent = "## 2025-01-01 [plan]\n\n設計完了。";
    const prompt = buildJobPrompt(makeJob("J000001"), logContent);
    expect(prompt).toContain("前回までの記録");
    expect(prompt).toContain("設計完了。");
  });

  test("does not include log section when logContent is null", () => {
    const prompt = buildJobPrompt(makeJob("J000001"), null);
    expect(prompt).not.toContain("前回までの記録");
  });

  test("review phase (auto) includes approved/rejected transitions", () => {
    const job = makeJob("J000001", {
      current_phase: "review",
      workflow: {
        phases: [
          { name: "review", type: "review", agent: "reviewer", auto: true, on: { approved: "COMPLETE", rejected: "ABORT" } },
        ],
      },
    });
    const prompt = buildJobPrompt(job, null);
    expect(prompt).toContain("ccsquad done J000001 approved");
    expect(prompt).toContain("ccsquad done J000001 rejected");
  });

  test("review phase (manual) instructs to stop and report", () => {
    const job = makeJob("J000001", {
      current_phase: "review",
      workflow: {
        phases: [
          { name: "review", type: "review", agent: "reviewer", on: { approved: "COMPLETE", rejected: "ABORT" } },
        ],
      },
    });
    const prompt = buildJobPrompt(job, null);
    expect(prompt).toContain("人間のレビュー");
  });
});
