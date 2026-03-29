import { describe, it, expect } from "bun:test";
import { parseWorkflowFromBody, generateWorkflowSection } from "../src/domain/workflow.js";

describe("parseWorkflowFromBody", () => {
  it("基本的なワークフローをパースする", () => {
    const body = `## Workflow

plan:
  type: plan
  on:
    completed: code
    failed: ABORT
code:
  type: execute
  on:
    completed: review
    failed: plan
review:
  type: review
  on:
    approved: COMPLETE
    rejected: code
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases).toHaveLength(3);
    expect(wf.phases[0].name).toBe("plan");
    expect(wf.phases[0].type).toBe("plan");
    expect(wf.phases[0].on.completed).toBe("code");
    expect(wf.phases[0].on.failed).toBe("ABORT");
    expect(wf.phases[1].name).toBe("code");
    expect(wf.phases[1].type).toBe("execute");
    expect(wf.phases[2].name).toBe("review");
    expect(wf.phases[2].type).toBe("review");
    expect(wf.phases[2].on.approved).toBe("COMPLETE");
    expect(wf.phases[2].on.rejected).toBe("code");
  });

  it("他のセクションがある場合も Workflow セクションのみパースする", () => {
    const body = `## 説明
何かの説明

## Workflow

plan:
  type: plan
  on:
    completed: COMPLETE

## フェーズログ
### plan (completed → COMPLETE) - 2026-01-01
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases).toHaveLength(1);
    expect(wf.phases[0].name).toBe("plan");
  });

  it("Workflow セクションがない場合エラーをスローする", () => {
    const body = `## 説明
何かの説明
`;
    expect(() => parseWorkflowFromBody(body)).toThrow("Workflow セクション");
  });

  it("Workflow セクションが空の場合エラーをスローする", () => {
    const body = `## Workflow

## 次のセクション
`;
    expect(() => parseWorkflowFromBody(body)).toThrow("Workflow セクション");
  });

  it("不正なフェーズタイプの場合エラーをスローする", () => {
    const body = `## Workflow

plan:
  type: invalid
  on:
    completed: COMPLETE
`;
    expect(() => parseWorkflowFromBody(body)).toThrow("不正なフェーズタイプ");
  });

  it("on が未定義の場合エラーをスローする", () => {
    const body = `## Workflow

plan:
  type: plan
`;
    expect(() => parseWorkflowFromBody(body)).toThrow("on (遷移ルール) が定義されていません");
  });

  it("不明な遷移条件の場合エラーをスローする", () => {
    const body = `## Workflow

plan:
  type: plan
  on:
    unknown: COMPLETE
`;
    expect(() => parseWorkflowFromBody(body)).toThrow("不明な遷移条件");
  });

  it("agent 指定ありのフェーズをパースする", () => {
    const body = `## Workflow

research:
  type: plan
  agent: planner
  on:
    completed: code
    failed: ABORT
code:
  type: execute
  agent: coder
  on:
    completed: review
    failed: research
review:
  type: review
  agent: reviewer
  on:
    approved: COMPLETE
    rejected: code
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases[0].agent).toBe("planner");
    expect(wf.phases[1].agent).toBe("coder");
    expect(wf.phases[2].agent).toBe("reviewer");
  });

  it("agent 省略時は undefined", () => {
    const body = `## Workflow

plan:
  type: plan
  on:
    completed: COMPLETE
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases[0].agent).toBeUndefined();
  });

  it("agent 指定ありと省略の混在をパースする", () => {
    const body = `## Workflow

plan:
  type: plan
  on:
    completed: code
    failed: ABORT
code:
  type: execute
  agent: coder
  on:
    completed: COMPLETE
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases[0].agent).toBeUndefined();
    expect(wf.phases[1].agent).toBe("coder");
  });

  it("auto キーワードをパースする", () => {
    const body = `## Workflow

plan:
  type: plan
  on:
    completed: code
    failed: ABORT
code:
  type: execute
  on:
    completed: review
    failed: plan
review:
  type: review
  auto: true
  on:
    approved: COMPLETE
    rejected: code
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases[2].auto).toBe(true);
    expect(wf.phases[0].auto).toBeUndefined();
  });

  it("agent と auto の両方を指定できる", () => {
    const body = `## Workflow

review:
  type: review
  agent: my-reviewer
  auto: true
  on:
    approved: COMPLETE
    rejected: code
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases[0].agent).toBe("my-reviewer");
    expect(wf.phases[0].auto).toBe(true);
  });

  it("auto 指定ありで generateWorkflowSection が正しく出力する", () => {
    const body = `## Workflow

plan:
  type: plan
  on:
    completed: review
    failed: ABORT
review:
  type: review
  agent: reviewer
  auto: true
  on:
    approved: COMPLETE
    rejected: plan
`;
    const wf = parseWorkflowFromBody(body);
    const output = generateWorkflowSection(wf);
    expect(output).toContain("type: review");
    expect(output).toContain("agent: reviewer");
    expect(output).toContain("auto: true");
  });
});

describe("generateWorkflowSection", () => {
  it("WorkflowConfig からテキストを生成する", () => {
    const wf = {
      phases: [
        { name: "plan", type: "plan" as const, on: { completed: "code", failed: "ABORT" } },
        { name: "code", type: "execute" as const, on: { completed: "review", failed: "plan" } },
        { name: "review", type: "review" as const, on: { approved: "COMPLETE", rejected: "code" } },
      ],
    };
    const text = generateWorkflowSection(wf);
    expect(text).toContain("## Workflow");
    expect(text).toContain("plan:");
    expect(text).toContain("type: plan");
    expect(text).toContain("code:");
    expect(text).toContain("type: execute");
    expect(text).toContain("review:");
    expect(text).toContain("type: review");
  });

  it("ラウンドトリップ: generate → parse が同一のワークフローを返す", () => {
    const original = {
      phases: [
        { name: "research", type: "plan" as const, on: { completed: "code", failed: "ABORT" } },
        { name: "code", type: "execute" as const, on: { completed: "review", failed: "research" } },
        { name: "review", type: "review" as const, on: { approved: "COMPLETE", rejected: "code" } },
      ],
    };
    const text = generateWorkflowSection(original);
    const parsed = parseWorkflowFromBody(text);

    expect(parsed.phases).toHaveLength(original.phases.length);
    for (let i = 0; i < original.phases.length; i++) {
      expect(parsed.phases[i].name).toBe(original.phases[i].name);
      expect(parsed.phases[i].type).toBe(original.phases[i].type);
      expect(parsed.phases[i].on).toEqual(original.phases[i].on);
    }
  });

  it("agent 指定ありのワークフローを生成する", () => {
    const wf = {
      phases: [
        { name: "plan", type: "plan" as const, agent: "planner", on: { completed: "code", failed: "ABORT" } },
        { name: "code", type: "execute" as const, on: { completed: "COMPLETE" } },
      ],
    };
    const text = generateWorkflowSection(wf);
    expect(text).toContain("agent: planner");
    expect(text).not.toMatch(/code:[\s\S]*agent:/);
  });

  it("ラウンドトリップ (agent あり): generate → parse で agent が保持される", () => {
    const original = {
      phases: [
        { name: "research", type: "plan" as const, agent: "planner", on: { completed: "code", failed: "ABORT" } },
        { name: "code", type: "execute" as const, on: { completed: "review", failed: "research" } },
        { name: "review", type: "review" as const, agent: "reviewer", on: { approved: "COMPLETE", rejected: "code" } },
      ],
    };
    const text = generateWorkflowSection(original);
    const parsed = parseWorkflowFromBody(text);

    expect(parsed.phases[0].agent).toBe("planner");
    expect(parsed.phases[1].agent).toBeUndefined();
    expect(parsed.phases[2].agent).toBe("reviewer");
  });
});
