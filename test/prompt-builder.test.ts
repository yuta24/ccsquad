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
      priority: 0,
      depends_on: [],
      acceptance_criteria: [],
      workflow: { phases: [] },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    },
    body: "",
  };
}

describe("buildJobPrompt", () => {
  test("includes job ID in prompt", () => {
    const prompt = buildJobPrompt(makeJob("J000042"));
    expect(prompt).toContain("J000042");
  });

  test("includes ccsquad commands with job ID", () => {
    const prompt = buildJobPrompt(makeJob("J000001"));
    expect(prompt).toContain("ccsquad job show J000001 --format json");
    expect(prompt).toContain("ccsquad job transition J000001 completed");
    expect(prompt).toContain("ccsquad job transition J000001 failed");
  });

  test("includes review phase instruction", () => {
    const prompt = buildJobPrompt(makeJob("J000001"));
    expect(prompt).toContain("review");
  });

  test("includes phase log reference", () => {
    const prompt = buildJobPrompt(makeJob("J000001"));
    expect(prompt).toContain(".ccsquad/logs/J000001.log");
  });

  test("includes acceptance criteria", () => {
    const job = makeJob("J000001", {
      acceptance_criteria: [
        { description: "テストが通ること", done: true },
        { description: "型エラーがないこと", done: false },
      ],
    });
    const prompt = buildJobPrompt(job);
    expect(prompt).toContain("[x] テストが通ること");
    expect(prompt).toContain("[ ] 型エラーがないこと");
  });

  test("includes job body", () => {
    const job = makeJob("J000001");
    job.body = "## 詳細\nこれはテスト用のジョブ内容です。";
    const prompt = buildJobPrompt(job);
    expect(prompt).toContain("これはテスト用のジョブ内容です。");
  });
});
