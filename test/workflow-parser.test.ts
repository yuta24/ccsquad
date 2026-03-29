import { describe, it, expect } from "bun:test";
import { parseWorkflowFromBody, generateWorkflowSection } from "../src/domain/workflow.js";

describe("parseWorkflowFromBody", () => {
  it("基本的なワークフローをパースする", () => {
    const body = `## Workflow

- plan: plan -> completed:code, failed:ABORT
- code: execute -> completed:review, failed:plan
- review: review -> approved:COMPLETE, rejected:code
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

  it("Unicode 矢印 → もサポートする", () => {
    const body = `## Workflow

- plan: plan → completed:code, failed:ABORT
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases[0].on.completed).toBe("code");
  });

  it("他のセクションがある場合も Workflow セクションのみパースする", () => {
    const body = `## 説明
何かの説明

## Workflow

- plan: plan -> completed:COMPLETE

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

- plan: invalid -> completed:COMPLETE
`;
    expect(() => parseWorkflowFromBody(body)).toThrow("不正なフェーズタイプ");
  });

  it("矢印がない行の場合エラーをスローする", () => {
    const body = `## Workflow

- plan: plan completed:COMPLETE
`;
    expect(() => parseWorkflowFromBody(body)).toThrow("不正なフェーズ定義");
  });

  it("不明な遷移条件の場合エラーをスローする", () => {
    const body = `## Workflow

- plan: plan -> unknown:COMPLETE
`;
    expect(() => parseWorkflowFromBody(body)).toThrow("不明な遷移条件");
  });

  it("agent 指定ありのフェーズをパースする", () => {
    const body = `## Workflow

- research: plan [planner] -> completed:code, failed:ABORT
- code: execute [coder] -> completed:review, failed:research
- review: review [reviewer] -> approved:COMPLETE, rejected:code
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases[0].agent).toBe("planner");
    expect(wf.phases[1].agent).toBe("coder");
    expect(wf.phases[2].agent).toBe("reviewer");
  });

  it("agent 省略時は undefined", () => {
    const body = `## Workflow

- plan: plan -> completed:COMPLETE
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases[0].agent).toBeUndefined();
  });

  it("agent 指定ありと省略の混在をパースする", () => {
    const body = `## Workflow

- plan: plan -> completed:code, failed:ABORT
- code: execute [coder] -> completed:COMPLETE
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases[0].agent).toBeUndefined();
    expect(wf.phases[1].agent).toBe("coder");
  });

  it("auto キーワードをパースする", () => {
    const body = `## Workflow

- plan: plan -> completed:code, failed:ABORT
- code: execute -> completed:review, failed:plan
- review: review auto -> approved:COMPLETE, rejected:code
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases[2].auto).toBe(true);
    expect(wf.phases[0].auto).toBeUndefined();
  });

  it("agent と auto の両方を指定できる", () => {
    const body = `## Workflow

- review: review [my-reviewer] auto -> approved:COMPLETE, rejected:code
`;
    const wf = parseWorkflowFromBody(body);
    expect(wf.phases[0].agent).toBe("my-reviewer");
    expect(wf.phases[0].auto).toBe(true);
  });

  it("auto 指定ありで generateWorkflowSection が正しく出力する", () => {
    const body = `## Workflow

- plan: plan -> completed:review, failed:ABORT
- review: review [reviewer] auto -> approved:COMPLETE, rejected:plan
`;
    const wf = parseWorkflowFromBody(body);
    const output = generateWorkflowSection(wf);
    expect(output).toContain("review: review [reviewer] auto -> approved:COMPLETE, rejected:plan");
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
    expect(text).toContain("plan: plan");
    expect(text).toContain("code: execute");
    expect(text).toContain("review: review");
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
    expect(text).toContain("plan: plan [planner]");
    expect(text).toContain("code: execute ->");
    expect(text).not.toContain("code: execute [");
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
