import { describe, it, expect } from "bun:test";
import { buildTaskPrompt, buildResumePrompt, buildReviewPrompt, truncateOutput } from "../src/service/prompt-builder.js";
import type { NodeOutput } from "../src/output.js";

function makeNodeOutput(phase: string, content: string, iteration = 1): NodeOutput {
  return {
    seq: 1,
    phase,
    executor: "test-agent",
    result: "completed",
    iteration,
    timestamp: new Date().toISOString(),
    content,
  };
}

// ─── truncateOutput ────────────────────────────────────────────────────────────

describe("truncateOutput", () => {
  it("maxChars 以下のコンテンツはそのまま返す", () => {
    const content = "短いコンテンツ";
    expect(truncateOutput(content, 100)).toBe(content);
  });

  it("maxChars を超えるコンテンツは省略される", () => {
    const content = "a".repeat(1000);
    const result = truncateOutput(content, 100);
    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain("省略");
  });

  it("省略後のテキストは先頭と末尾を含む", () => {
    const content = "HEAD" + "x".repeat(1000) + "TAIL";
    const result = truncateOutput(content, 100);
    expect(result).toContain("HEAD");
    expect(result).toContain("TAIL");
  });

  it("省略された文字数を表示する", () => {
    const content = "a".repeat(1000);
    const result = truncateOutput(content, 100);
    expect(result).toMatch(/\d+ 文字省略/);
  });

  it("デフォルトの maxChars は 50000", () => {
    const content = "a".repeat(50000);
    expect(truncateOutput(content)).toBe(content);

    const longContent = "a".repeat(50001);
    const result = truncateOutput(longContent);
    expect(result).toContain("省略");
  });

  it("ちょうど maxChars と同じ長さはそのまま返す", () => {
    const content = "a".repeat(100);
    expect(truncateOutput(content, 100)).toBe(content);
  });
});

// ─── buildTaskPrompt ───────────────────────────────────────────────────────────

describe("buildTaskPrompt", () => {
  it("基本的なプロンプトを生成する", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テストタスク",
      phase: "plan",
      iteration: 1,
      jobBody: "## 説明\nタスクの説明文",
      previousOutputs: [],
    });

    expect(result).toContain("J000001");
    expect(result).toContain("テストタスク");
    expect(result).toContain("plan");
    expect(result).toContain("1");
    expect(result).toContain("タスクの説明文");
  });

  it("phaseDescription が設定されている場合含まれる", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "plan",
      phaseDescription: "実装計画を策定する",
      iteration: 1,
      jobBody: "本文",
      previousOutputs: [],
    });

    expect(result).toContain("実装計画を策定する");
  });

  it("phaseDescription が未設定の場合含まれない", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "plan",
      iteration: 1,
      jobBody: "本文",
      previousOutputs: [],
    });

    expect(result).not.toContain("フェーズ説明:");
  });

  it("previousOutputs が空の場合前フェーズの出力セクションが含まれない", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "plan",
      iteration: 1,
      jobBody: "本文",
      previousOutputs: [],
    });

    expect(result).not.toContain("前フェーズの出力");
  });

  it("previousOutputs がある場合最後の出力が含まれる", () => {
    const outputs = [
      makeNodeOutput("plan", "計画フェーズの出力", 1),
      makeNodeOutput("code", "コードフェーズの出力", 1),
    ];

    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      previousOutputs: outputs,
    });

    expect(result).toContain("前フェーズの出力");
    expect(result).toContain("コードフェーズの出力");
    expect(result).not.toContain("計画フェーズの出力");
  });

  it("ジョブIDのラベルが含まれる", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "plan",
      iteration: 1,
      jobBody: "本文",
      previousOutputs: [],
    });

    expect(result).toContain("ジョブID:");
  });

  it("phasePromptがフェーズ指示セクションとして含まれる", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "code",
      iteration: 1,
      jobBody: "本文",
      previousOutputs: [],
      phasePrompt: "テストも必ず書くこと",
    });

    expect(result).toContain("## フェーズ指示");
    expect(result).toContain("テストも必ず書くこと");
  });

  it("includeOutputPhasesで指定フェーズの出力のみ含まれる", () => {
    const outputs = [
      makeNodeOutput("plan", "計画の出力", 1),
      makeNodeOutput("code", "コードの出力", 1),
      makeNodeOutput("test", "テストの出力", 1),
    ];

    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      previousOutputs: outputs,
      includeOutputPhases: ["plan", "code"],
    });

    expect(result).toContain("計画の出力");
    expect(result).toContain("コードの出力");
    expect(result).not.toContain("テストの出力");
  });

  it("includeOutputPhasesが空配列で前フェーズ出力なし", () => {
    const outputs = [
      makeNodeOutput("plan", "計画の出力", 1),
    ];

    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "code",
      iteration: 1,
      jobBody: "本文",
      previousOutputs: outputs,
      includeOutputPhases: [],
    });

    expect(result).not.toContain("前フェーズの出力");
    expect(result).not.toContain("計画の出力");
  });

  it("includeOutputPhases未指定は従来通り最後の出力のみ", () => {
    const outputs = [
      makeNodeOutput("plan", "計画の出力", 1),
      makeNodeOutput("code", "コードの出力", 1),
    ];

    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      previousOutputs: outputs,
    });

    expect(result).toContain("コードの出力");
    expect(result).not.toContain("計画の出力");
  });
});

// ─── buildResumePrompt ─────────────────────────────────────────────────────────

describe("buildResumePrompt", () => {
  it("taskタイプのプロンプトを生成する", () => {
    const result = buildResumePrompt({
      phase: "plan",
      phaseType: "task",
      iteration: 2,
      feedback: "修正が必要です",
    });

    expect(result).toContain("reject");
    expect(result).toContain("修正してください");
    expect(result).toContain("修正が必要です");
    expect(result).toContain("2");
  });

  it("reviewタイプのプロンプトを生成する", () => {
    const result = buildResumePrompt({
      phase: "review",
      phaseType: "review",
      iteration: 3,
      feedback: "修正後の実行結果",
    });

    expect(result).toContain("再レビュー");
    expect(result).toContain("修正後の実行結果");
    expect(result).toContain("3");
  });

  it("taskタイプは reject 理由セクションを含む", () => {
    const result = buildResumePrompt({
      phase: "plan",
      phaseType: "task",
      iteration: 1,
      feedback: "reject 理由",
    });

    expect(result).toContain("reject 理由");
  });

  it("reviewタイプは修正後の実行結果セクションを含む", () => {
    const result = buildResumePrompt({
      phase: "review",
      phaseType: "review",
      iteration: 1,
      feedback: "実行結果の内容",
    });

    expect(result).toContain("修正後の実行結果");
    expect(result).toContain("実行結果の内容");
  });

  it("phasePromptがフェーズ指示セクションとして含まれる (task)", () => {
    const result = buildResumePrompt({
      phase: "code",
      phaseType: "task",
      iteration: 2,
      feedback: "修正理由",
      phasePrompt: "テストも書くこと",
    });

    expect(result).toContain("## フェーズ指示");
    expect(result).toContain("テストも書くこと");
  });

  it("phasePromptがフェーズ指示セクションとして含まれる (review)", () => {
    const result = buildResumePrompt({
      phase: "review",
      phaseType: "review",
      iteration: 2,
      feedback: "修正結果",
      phasePrompt: "セキュリティに注意",
    });

    expect(result).toContain("## フェーズ指示");
    expect(result).toContain("セキュリティに注意");
  });
});

// ─── buildReviewPrompt ─────────────────────────────────────────────────────────

describe("buildReviewPrompt", () => {
  it("基本的なレビュープロンプトを生成する", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "レビュータスク",
      phase: "review",
      iteration: 1,
      jobBody: "## 説明\nレビューの説明",
      taskOutput: "タスクの実行結果",
    });

    expect(result).toContain("J000001");
    expect(result).toContain("レビュータスク");
    expect(result).toContain("review");
    expect(result).toContain("1");
    expect(result).toContain("レビューの説明");
    expect(result).toContain("タスクの実行結果");
  });

  it("phaseDescription が設定されている場合含まれる", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      phaseDescription: "コードレビューを行う",
      iteration: 1,
      jobBody: "本文",
      taskOutput: "出力",
    });

    expect(result).toContain("コードレビューを行う");
  });

  it("phaseDescription が未設定の場合含まれない", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      taskOutput: "出力",
    });

    expect(result).not.toContain("フェーズ説明:");
  });

  it("レビュー対象セクションを含む", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      taskOutput: "レビュー対象の出力",
    });

    expect(result).toContain("レビュー対象");
    expect(result).toContain("レビュー対象の出力");
  });

  it("ジョブIDのラベルが含まれる", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      taskOutput: "出力",
    });

    expect(result).toContain("ジョブID:");
  });

  it("phasePromptがフェーズ指示セクションとして含まれる", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      taskOutput: "出力",
      phasePrompt: "セキュリティ観点でレビュー",
    });

    expect(result).toContain("## フェーズ指示");
    expect(result).toContain("セキュリティ観点でレビュー");
  });

  it("includeOutputPhasesで関連フェーズの出力が含まれる", () => {
    const outputs = [
      makeNodeOutput("plan", "計画の出力", 1),
      makeNodeOutput("code", "コードの出力", 1),
    ];

    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      taskOutput: "コードの出力",
      previousOutputs: outputs,
      includeOutputPhases: ["plan", "code"],
    });

    expect(result).toContain("## 参考: 関連フェーズの出力");
    expect(result).toContain("計画の出力");
    expect(result).toContain("## レビュー対象");
  });
});
