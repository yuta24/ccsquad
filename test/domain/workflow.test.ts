import { describe, it, expect } from "bun:test";
import {
  parseWorkflowObject,
  resolveTransition,
  validateConditionForPhase,
  getPhase,
  initialPhase,
} from "../../src/domain/workflow.js";
import type { WorkflowConfig } from "../../src/domain/types.js";

// ── テスト用ワークフロー ──

const BASIC_WF_OBJ = {
  plan: { type: "plan", agent: "developer", on: { completed: "execute", failed: "ABORT" } },
  execute: { type: "execute", agent: "developer", on: { completed: "review", failed: "plan" } },
  review: { type: "review", agent: "reviewer", on: { approved: "COMPLETE", rejected: "execute" } },
};

const basicWorkflow = (): WorkflowConfig => parseWorkflowObject(BASIC_WF_OBJ);

describe("parseWorkflowObject", () => {
  it("正常なオブジェクトをパースできる", () => {
    const wf = basicWorkflow();
    expect(wf.phases).toHaveLength(3);
    expect(wf.phases[0].name).toBe("plan");
    expect(wf.phases[1].name).toBe("execute");
    expect(wf.phases[2].name).toBe("review");
  });

  it("各フェーズの type と agent を正しくパースする", () => {
    const wf = basicWorkflow();
    expect(wf.phases[0].type).toBe("plan");
    expect(wf.phases[0].agent).toBe("developer");
  });

  it("auto フィールドをパースする", () => {
    const obj = {
      review: { type: "review", agent: "reviewer", auto: true, on: { approved: "COMPLETE", rejected: "ABORT" } },
    };
    const wf = parseWorkflowObject(obj);
    expect(wf.phases[0].auto).toBe(true);
  });

  it("auto がない場合は undefined", () => {
    const wf = basicWorkflow();
    expect(wf.phases[0].auto).toBeUndefined();
  });

  it("フェーズが空の場合はエラー", () => {
    expect(() => parseWorkflowObject({})).toThrow("workflow にフェーズが定義されていません");
  });

  it("不正なフェーズタイプでエラー", () => {
    const obj = { step: { type: "unknown", agent: "dev", on: { completed: "COMPLETE" } } };
    expect(() => parseWorkflowObject(obj)).toThrow("不正なフェーズタイプ");
  });

  it("agent がない場合はエラー", () => {
    const obj = { plan: { type: "plan", on: { completed: "COMPLETE" } } };
    expect(() => parseWorkflowObject(obj)).toThrow("agent を指定してください");
  });

  it("on がない場合はエラー", () => {
    const obj = { plan: { type: "plan", agent: "dev" } };
    expect(() => parseWorkflowObject(obj)).toThrow("on (遷移ルール) が定義されていません");
  });

  it("配列を渡した場合はエラー", () => {
    expect(() => parseWorkflowObject([])).toThrow("workflow はオブジェクトで指定してください");
  });

  it("null を渡した場合はエラー", () => {
    expect(() => parseWorkflowObject(null)).toThrow("workflow はオブジェクトで指定してください");
  });

  it("遷移先に存在しないフェーズ名を指定するとエラー", () => {
    const obj = {
      plan: { type: "plan", agent: "developer", on: { completed: "typo-phase", failed: "ABORT" } },
    };
    expect(() => parseWorkflowObject(obj)).toThrow("存在しないフェーズです");
  });

  it("遷移先が COMPLETE/ABORT の場合はフェーズチェックをしない", () => {
    const obj = {
      plan: { type: "plan", agent: "developer", on: { completed: "COMPLETE", failed: "ABORT" } },
    };
    expect(() => parseWorkflowObject(obj)).not.toThrow();
  });

  it("複数フェーズで遷移先が存在しないフェーズを参照するとエラー", () => {
    const obj = {
      plan: { type: "plan", agent: "developer", on: { completed: "execute", failed: "ABORT" } },
      execute: { type: "execute", agent: "developer", on: { completed: "nonexistent", failed: "plan" } },
    };
    expect(() => parseWorkflowObject(obj)).toThrow("'nonexistent' は存在しないフェーズです");
  });
});

describe("initialPhase", () => {
  it("最初のフェーズを返す", () => {
    const wf = basicWorkflow();
    expect(initialPhase(wf).name).toBe("plan");
  });

  it("フェーズが空の場合はエラー", () => {
    expect(() => initialPhase({ phases: [] })).toThrow("フェーズが定義されていません");
  });
});

describe("getPhase", () => {
  it("名前で指定したフェーズを返す", () => {
    const wf = basicWorkflow();
    const phase = getPhase(wf, "execute");
    expect(phase?.name).toBe("execute");
    expect(phase?.type).toBe("execute");
  });

  it("存在しないフェーズ名は undefined を返す", () => {
    const wf = basicWorkflow();
    expect(getPhase(wf, "nonexistent")).toBeUndefined();
  });
});

describe("resolveTransition", () => {
  it("フェーズ名と条件から遷移先を返す", () => {
    const wf = basicWorkflow();
    expect(resolveTransition(wf, "plan", "completed")).toBe("execute");
    expect(resolveTransition(wf, "plan", "failed")).toBe("ABORT");
    expect(resolveTransition(wf, "execute", "completed")).toBe("review");
    expect(resolveTransition(wf, "review", "approved")).toBe("COMPLETE");
  });

  it("存在しないフェーズ名でエラー", () => {
    const wf = basicWorkflow();
    expect(() => resolveTransition(wf, "nonexistent", "completed")).toThrow("フェーズ 'nonexistent' がワークフローに定義されていません");
  });

  it("遷移ルールにない条件でエラー", () => {
    const wf = basicWorkflow();
    expect(() => resolveTransition(wf, "plan", "approved")).toThrow("条件 'approved' に一致するルールがありません");
  });
});

describe("validateConditionForPhase", () => {
  it("review フェーズで approved は OK", () => {
    expect(() => validateConditionForPhase("review", "approved")).not.toThrow();
  });

  it("review フェーズで rejected は OK", () => {
    expect(() => validateConditionForPhase("review", "rejected")).not.toThrow();
  });

  it("review フェーズで completed はエラー", () => {
    expect(() => validateConditionForPhase("review", "completed")).toThrow("approved/rejected を使用してください");
  });

  it("review フェーズで failed はエラー", () => {
    expect(() => validateConditionForPhase("review", "failed")).toThrow("approved/rejected を使用してください");
  });

  it("plan フェーズで completed は OK", () => {
    expect(() => validateConditionForPhase("plan", "completed")).not.toThrow();
  });

  it("plan フェーズで approved はエラー", () => {
    expect(() => validateConditionForPhase("plan", "approved")).toThrow("completed/failed を使用してください");
  });

  it("execute フェーズで rejected はエラー", () => {
    expect(() => validateConditionForPhase("execute", "rejected")).toThrow("completed/failed を使用してください");
  });
});
