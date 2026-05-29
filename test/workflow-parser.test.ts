import { describe, it, expect } from "bun:test";
import { parseWorkflowObject } from "../src/domain/workflow.js";
import { workflowToObject } from "../src/domain/types.js";

describe("parseWorkflowObject", () => {
  it("基本的なワークフローをパースする", () => {
    const obj = {
      plan: { type: "plan", agent: "developer", on: { completed: "code", failed: "ABORT" } },
      code: { type: "execute", agent: "developer", on: { completed: "review", failed: "plan" } },
      review: { type: "review", agent: "reviewer", on: { approved: "COMPLETE", rejected: "code" } },
    };
    const wf = parseWorkflowObject(obj);
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

  it("非オブジェクトの場合エラーをスローする", () => {
    expect(() => parseWorkflowObject("invalid")).toThrow("オブジェクト");
    expect(() => parseWorkflowObject(null)).toThrow("オブジェクト");
    expect(() => parseWorkflowObject([1, 2])).toThrow("オブジェクト");
  });

  it("空オブジェクトの場合エラーをスローする", () => {
    expect(() => parseWorkflowObject({})).toThrow("フェーズが定義されていません");
  });

  it("不正なフェーズタイプの場合エラーをスローする", () => {
    const obj = { plan: { type: "invalid", agent: "dev", on: { completed: "COMPLETE" } } };
    expect(() => parseWorkflowObject(obj)).toThrow("不正なフェーズタイプ");
  });

  it("on が未定義の場合エラーをスローする", () => {
    const obj = { plan: { type: "plan", agent: "developer" } };
    expect(() => parseWorkflowObject(obj)).toThrow("on (遷移ルール) が定義されていません");
  });

  it("不明な遷移条件の場合エラーをスローする", () => {
    const obj = { plan: { type: "plan", agent: "developer", on: { unknown: "COMPLETE" } } };
    expect(() => parseWorkflowObject(obj)).toThrow("不明な遷移条件");
  });

  it("agent 指定ありのフェーズをパースする", () => {
    const obj = {
      research: { type: "plan", agent: "planner", on: { completed: "code", failed: "ABORT" } },
      code: { type: "execute", agent: "coder", on: { completed: "review", failed: "research" } },
      review: { type: "review", agent: "reviewer", on: { approved: "COMPLETE", rejected: "code" } },
    };
    const wf = parseWorkflowObject(obj);
    expect(wf.phases[0].agent).toBe("planner");
    expect(wf.phases[1].agent).toBe("coder");
    expect(wf.phases[2].agent).toBe("reviewer");
  });

  it("agent 省略時はエラーをスローする", () => {
    const obj = { plan: { type: "plan", on: { completed: "COMPLETE" } } };
    expect(() => parseWorkflowObject(obj)).toThrow("agent を指定してください");
  });

  it("auto キーワードをパースする", () => {
    const obj = {
      plan: { type: "plan", agent: "developer", on: { completed: "code", failed: "ABORT" } },
      code: { type: "execute", agent: "developer", on: { completed: "review", failed: "plan" } },
      review: { type: "review", agent: "reviewer", auto: true, on: { approved: "COMPLETE", rejected: "code" } },
    };
    const wf = parseWorkflowObject(obj);
    expect(wf.phases[2].auto).toBe(true);
    expect(wf.phases[0].auto).toBeUndefined();
  });

  it("agent と auto の両方を指定できる", () => {
    const obj = {
      review: { type: "review", agent: "my-reviewer", auto: true, on: { approved: "COMPLETE", rejected: "code" } },
    };
    const wf = parseWorkflowObject(obj);
    expect(wf.phases[0].agent).toBe("my-reviewer");
    expect(wf.phases[0].auto).toBe(true);
  });
});

describe("workflowToObject", () => {
  it("WorkflowConfig からオブジェクトを生成する", () => {
    const wf = {
      phases: [
        { name: "plan", type: "plan" as const, agent: "developer", on: { completed: "code", failed: "ABORT" } },
        { name: "code", type: "execute" as const, agent: "developer", on: { completed: "review", failed: "plan" } },
        { name: "review", type: "review" as const, agent: "reviewer", on: { approved: "COMPLETE", rejected: "code" } },
      ],
    };
    const obj = workflowToObject(wf);
    expect(obj.plan.type).toBe("plan");
    expect(obj.plan.agent).toBe("developer");
    expect(obj.code.type).toBe("execute");
    expect(obj.review.type).toBe("review");
  });

  it("ラウンドトリップ: toObject → parse が同一のワークフローを返す", () => {
    const original = {
      phases: [
        { name: "research", type: "plan" as const, agent: "planner", on: { completed: "code", failed: "ABORT" } },
        { name: "code", type: "execute" as const, agent: "developer", on: { completed: "review", failed: "research" } },
        { name: "review", type: "review" as const, agent: "reviewer", on: { approved: "COMPLETE", rejected: "code" } },
      ],
    };
    const obj = workflowToObject(original);
    const parsed = parseWorkflowObject(obj);

    expect(parsed.phases).toHaveLength(original.phases.length);
    for (let i = 0; i < original.phases.length; i++) {
      expect(parsed.phases[i].name).toBe(original.phases[i].name);
      expect(parsed.phases[i].type).toBe(original.phases[i].type);
      expect(parsed.phases[i].on).toEqual(original.phases[i].on);
    }
  });

  it("ラウンドトリップ (agent あり): toObject → parse で agent が保持される", () => {
    const original = {
      phases: [
        { name: "research", type: "plan" as const, agent: "planner", on: { completed: "code", failed: "ABORT" } },
        { name: "code", type: "execute" as const, agent: "developer", on: { completed: "review", failed: "research" } },
        { name: "review", type: "review" as const, agent: "reviewer", on: { approved: "COMPLETE", rejected: "code" } },
      ],
    };
    const obj = workflowToObject(original);
    const parsed = parseWorkflowObject(obj);

    expect(parsed.phases[0].agent).toBe("planner");
    expect(parsed.phases[1].agent).toBe("developer");
    expect(parsed.phases[2].agent).toBe("reviewer");
  });

  it("auto 指定ありでラウンドトリップが正しい", () => {
    const original = {
      phases: [
        { name: "plan", type: "plan" as const, agent: "developer", on: { completed: "review", failed: "ABORT" } },
        { name: "review", type: "review" as const, agent: "reviewer", auto: true, on: { approved: "COMPLETE", rejected: "plan" } },
      ],
    };
    const obj = workflowToObject(original);
    const parsed = parseWorkflowObject(obj);
    expect(parsed.phases[1].auto).toBe(true);
  });
});
