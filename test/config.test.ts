import { describe, it, expect } from "bun:test";
import { SquadConfigImpl, parseTransitionCondition, isTaskLikeType, getOutputFormat } from "../src/config.js";
import type { PhaseConfig } from "../src/config.js";
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
    const diagnostics = config.lint();
    expect(diagnostics.length).toBe(0);
  });

  it("空のphasesでエラー", () => {
    const yaml = `
workflows:
  test:
    phases: []
`;
    const config = SquadConfigImpl.parse(yaml);
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("フェーズが定義されていません");
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
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("存在しません");
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
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("completed");
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
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("approved");
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
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("rejected");
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
    const diagnostics = config.lint();
    const warnings = diagnostics.filter(d => d.severity === "warning");
    expect(warnings.length).toBe(1);
    expect(warnings[0].phase).toContain("orphan");
    expect(warnings[0].message).toContain("到達不能");
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
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("type");
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
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("agent");
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
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("reviewer");
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
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("reviewer");
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
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("agent");
  });

  it("不正な type 値を持つフェーズで lint() がエラー診断を返す", () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: plan
        type: unknown
        agent: planner
        on:
          completed: COMPLETE
`;
    const config = SquadConfigImpl.parse(yaml);
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
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

  it("promptフィールドがパースされる", () => {
    const yaml = `
workflows:
  dev:
    phases:
      - name: code
        type: task
        agent: coder
        prompt: |
          テストも必ず書くこと
        on:
          completed: COMPLETE
`;
    const config = SquadConfigImpl.parse(yaml);
    const dev = config.getWorkflow("dev")!;
    const code = dev.getPhase("code");
    expect(code?.prompt).toContain("テストも必ず書くこと");
  });

  it("promptが未設定でも正常にパースされる", () => {
    const config = SquadConfigImpl.parse(devWorkflowYaml());
    const dev = config.getWorkflow("dev")!;
    const plan = dev.getPhase("plan");
    expect(plan?.prompt).toBeUndefined();
  });
});

// ─── isTaskLikeType ────────────────────────────────────────────────────────────

describe("isTaskLikeType", () => {
  it('"task" → true', () => {
    expect(isTaskLikeType("task")).toBe(true);
  });

  it('"research" → true', () => {
    expect(isTaskLikeType("research")).toBe(true);
  });

  it('"plan" → true', () => {
    expect(isTaskLikeType("plan")).toBe(true);
  });

  it('"code" → true', () => {
    expect(isTaskLikeType("code")).toBe(true);
  });

  it('"review" → false', () => {
    expect(isTaskLikeType("review")).toBe(false);
  });
});

// ─── getOutputFormat ───────────────────────────────────────────────────────────

describe("getOutputFormat", () => {
  function makePhase(type: PhaseConfig["type"], output_format?: PhaseConfig["output_format"]): PhaseConfig {
    const phase: PhaseConfig = {
      name: "test",
      type,
      on: { completed: "COMPLETE" },
    };
    if (output_format !== undefined) {
      phase.output_format = output_format;
    }
    return phase;
  }

  it('type: "research" で output_format 未設定 → デフォルト値 4件', () => {
    const result = getOutputFormat(makePhase("research"));
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBe(4);
    expect(result).toContain("## 調査結果");
  });

  it('type: "task" で output_format 未設定 → null', () => {
    const result = getOutputFormat(makePhase("task"));
    expect(result).toBeNull();
  });

  it("output_format 明示設定 → デフォルトを上書き", () => {
    const custom = ["## カスタムセクション", "## 追加情報"];
    const result = getOutputFormat(makePhase("research", custom));
    expect(result).toEqual(custom);
  });

  it("output_format: null 明示設定 → null が返る", () => {
    // YAML パーサーが null を undefined に変換する場合もあるが、
    // PhaseConfig 直接作成時は null として扱われる
    const phase = makePhase("research");
    phase.output_format = null;
    const result = getOutputFormat(phase);
    expect(result).toBeNull();
  });
});

// ─── YAML パース: output_format 配列 ──────────────────────────────────────────

describe("YAML パース - output_format", () => {
  it("output_format を配列として YAML に書いたときパースされる", () => {
    const yaml = `
workflows:
  dev:
    phases:
      - name: analyze
        type: research
        agent: researcher
        output_format:
          - "## 調査結果"
          - "## まとめ"
        on:
          completed: COMPLETE
`;
    const config = SquadConfigImpl.parse(yaml);
    const dev = config.getWorkflow("dev")!;
    const phase = dev.getPhase("analyze");
    expect(phase?.output_format).toEqual(["## 調査結果", "## まとめ"]);
  });
});

// ─── lint（新 PhaseType） ──────────────────────────────────────────────────────

describe("lint - 新 PhaseType", () => {
  it('type: "research" + agent + completed → エラーなし', () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: analyze
        type: research
        agent: researcher
        on:
          completed: COMPLETE
`;
    const config = SquadConfigImpl.parse(yaml);
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBe(0);
  });

  it('type: "plan" + agent なし → エラー', () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: plan
        type: plan
        on:
          completed: COMPLETE
`;
    const config = SquadConfigImpl.parse(yaml);
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("agent");
  });

  it('type: "code" + reviewer あり → エラー', () => {
    const yaml = `
workflows:
  test:
    phases:
      - name: code
        type: code
        agent: coder
        reviewer: human
        on:
          completed: COMPLETE
`;
    const config = SquadConfigImpl.parse(yaml);
    const diagnostics = config.lint();
    const errors = diagnostics.filter(d => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("reviewer");
  });
});
