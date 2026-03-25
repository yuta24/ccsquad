import { describe, it, expect } from "bun:test";
import { SquadConfigImpl, parseTransitionCondition } from "../src/config.js";
import { CcsquadError } from "../src/error.js";

function devWorkflowYaml(): string {
  return `
workflows:
  dev:
    description: 開発ワークフロー
    phases:
      - name: plan
        type: task
        description: 実装計画を策定する
        agent: planner
        on:
          completed: code
          failed: ABORT
      - name: code
        type: task
        description: コードを実装する
        agent: coder
        on:
          completed: review
          failed: plan
      - name: review
        type: review
        description: コードレビューを行う
        reviewer: human
        on:
          approved: COMPLETE
          rejected: code
`;
}

describe("config", () => {
  it("配列型phasesをパースする", () => {
    const config = SquadConfigImpl.parse(devWorkflowYaml());
    expect(Object.keys(config.workflows).length).toBe(1);
    const dev = config.getWorkflow("dev");
    expect(dev).toBeDefined();
    expect(dev!.initialPhase().name).toBe("plan");
    expect(dev!.phases.length).toBe(3);
    const review = dev!.getPhase("review");
    expect(review?.reviewer).toBe("human");
  });

  it("有効な設定のバリデーション", () => {
    const config = SquadConfigImpl.parse(devWorkflowYaml());
    const warnings = config.validate();
    expect(warnings.length).toBe(0);
  });

  it("空のphasesでエラー", () => {
    const yaml = `
workflows:
  test:
    phases: []
`;
    const config = SquadConfigImpl.parse(yaml);
    expect(() => config.validate()).toThrow(CcsquadError);
  });

  it("存在しない遷移先でエラー", () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: plan
        type: task
        agent: planner
        on:
          completed: nonexistent
`;
    const config = SquadConfigImpl.parse(yaml);
    let error: CcsquadError | undefined;
    try {
      config.validate();
    } catch (e) {
      error = e as CcsquadError;
    }
    expect(error).toBeInstanceOf(CcsquadError);
    expect(error!.message).toContain("存在しません");
  });

  it("completedルールなしでエラー", () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: plan
        type: task
        agent: planner
`;
    const config = SquadConfigImpl.parse(yaml);
    let error: CcsquadError | undefined;
    try {
      config.validate();
    } catch (e) {
      error = e as CcsquadError;
    }
    expect(error).toBeInstanceOf(CcsquadError);
    expect(error!.message).toContain("completed");
  });

  it("reviewerフェーズにapprovedなしでエラー", () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: review
        type: review
        reviewer: human
        on:
          rejected: ABORT
`;
    const config = SquadConfigImpl.parse(yaml);
    let error: CcsquadError | undefined;
    try {
      config.validate();
    } catch (e) {
      error = e as CcsquadError;
    }
    expect(error).toBeInstanceOf(CcsquadError);
    expect(error!.message).toContain("approved");
  });

  it("reviewerフェーズにrejectedなしでエラー", () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: review
        type: review
        reviewer: human
        on:
          approved: COMPLETE
`;
    const config = SquadConfigImpl.parse(yaml);
    let error: CcsquadError | undefined;
    try {
      config.validate();
    } catch (e) {
      error = e as CcsquadError;
    }
    expect(error).toBeInstanceOf(CcsquadError);
    expect(error!.message).toContain("rejected");
  });

  it("到達不能フェーズで警告", () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: plan
        type: task
        agent: planner
        on:
          completed: COMPLETE
      - name: orphan
        type: task
        agent: coder
        on:
          completed: COMPLETE
`;
    const config = SquadConfigImpl.parse(yaml);
    const warnings = config.validate();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("orphan");
    expect(warnings[0]).toContain("到達不能");
  });

  it("遷移先の解決", () => {
    const config = SquadConfigImpl.parse(devWorkflowYaml());
    const dev = config.getWorkflow("dev")!;

    expect(dev.resolveTransition("plan", "completed")).toBe("code");
    expect(dev.resolveTransition("plan", "failed")).toBe("ABORT");
    expect(dev.resolveTransition("code", "failed")).toBe("plan");
    expect(dev.resolveTransition("review", "approved")).toBe("COMPLETE");
    expect(dev.resolveTransition("review", "rejected")).toBe("code");
  });

  it("一致するルールなしでエラー", () => {
    const config = SquadConfigImpl.parse(devWorkflowYaml());
    const dev = config.getWorkflow("dev")!;
    expect(() => dev.resolveTransition("code", "rejected")).toThrow(CcsquadError);
  });

  it("TransitionConditionの表示とパース", () => {
    // In TypeScript we use string literals directly
    const completed: string = "completed";
    expect(completed).toBe("completed");

    // parseTransitionCondition
    expect(parseTransitionCondition("completed")).toBe("completed");
    expect(() => parseTransitionCondition("invalid")).toThrow(CcsquadError);
  });

  it("typeフィールドが必須", () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: plan
        agent: planner
        on:
          completed: COMPLETE
`;
    const config = SquadConfigImpl.parse(yaml);
    let error: CcsquadError | undefined;
    try {
      config.validate();
    } catch (e) {
      error = e as CcsquadError;
    }
    expect(error).toBeInstanceOf(CcsquadError);
    expect(error!.message).toContain("type");
  });

  it("taskフェーズにはagentが必須", () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: plan
        type: task
        on:
          completed: COMPLETE
`;
    const config = SquadConfigImpl.parse(yaml);
    let error: CcsquadError | undefined;
    try {
      config.validate();
    } catch (e) {
      error = e as CcsquadError;
    }
    expect(error).toBeInstanceOf(CcsquadError);
    expect(error!.message).toContain("agent");
  });

  it("reviewフェーズにはreviewerが必須", () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: review
        type: review
        on:
          approved: COMPLETE
          rejected: ABORT
`;
    const config = SquadConfigImpl.parse(yaml);
    let error: CcsquadError | undefined;
    try {
      config.validate();
    } catch (e) {
      error = e as CcsquadError;
    }
    expect(error).toBeInstanceOf(CcsquadError);
    expect(error!.message).toContain("reviewer");
  });

  it("taskフェーズにreviewerは設定できない", () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: plan
        type: task
        agent: planner
        reviewer: human
        on:
          completed: COMPLETE
`;
    const config = SquadConfigImpl.parse(yaml);
    let error: CcsquadError | undefined;
    try {
      config.validate();
    } catch (e) {
      error = e as CcsquadError;
    }
    expect(error).toBeInstanceOf(CcsquadError);
    expect(error!.message).toContain("reviewer");
  });

  it("reviewフェーズにagentは設定できない", () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: review
        type: review
        reviewer: human
        agent: some-agent
        on:
          approved: COMPLETE
          rejected: ABORT
`;
    const config = SquadConfigImpl.parse(yaml);
    let error: CcsquadError | undefined;
    try {
      config.validate();
    } catch (e) {
      error = e as CcsquadError;
    }
    expect(error).toBeInstanceOf(CcsquadError);
    expect(error!.message).toContain("agent");
  });

  it("max_iterationsのデフォルト値は10", () => {
    const config = SquadConfigImpl.parse(devWorkflowYaml());
    const dev = config.getWorkflow("dev")!;
    expect(dev.max_iterations).toBeUndefined();
    expect(dev.maxIterations()).toBe(10);
  });

  it("max_iterationsのカスタム値", () => {
    const yaml = `
workflows:
  dev:
    max_iterations: 5
    phases:
      - name: plan
        type: task
        agent: planner
        on:
          completed: COMPLETE
`;
    const config = SquadConfigImpl.parse(yaml);
    const dev = config.getWorkflow("dev")!;
    expect(dev.maxIterations()).toBe(5);
  });
});
