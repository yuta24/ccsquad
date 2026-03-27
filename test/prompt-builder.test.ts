import { describe, it, expect } from "bun:test";
import { buildTaskPrompt, buildResumePrompt, buildReviewPrompt } from "../src/service/prompt-builder.js";
import type { OutputFileRef } from "../src/service/prompt-builder.js";

function makeOutputFileRef(phase: string, seq: number): OutputFileRef {
  return { seq, phase, filePath: `.ccsquad/outputs/J000001/${seq}-${phase}.md` };
}

// ─── buildTaskPrompt ───────────────────────────────────────────────────────────

describe("buildTaskPrompt", () => {
  it("基本的なプロンプトを生成する", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テストタスク",
      phase: "plan",
      iteration: 1,
      jobBody: "## 説明\nタスクの説明文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      outputFiles: [],
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
      jobFilePath: ".ccsquad/jobs/J000001.md",
      outputFiles: [],
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
      jobFilePath: ".ccsquad/jobs/J000001.md",
      outputFiles: [],
    });

    expect(result).not.toContain("フェーズ説明:");
  });

  it("outputFiles が空の場合前フェーズの出力セクションが含まれない", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "plan",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      outputFiles: [],
    });

    expect(result).not.toContain("前フェーズの出力");
  });

  it("outputFiles がある場合ファイルパス参照が含まれる", () => {
    const files = [
      makeOutputFileRef("plan", 1),
      makeOutputFileRef("code", 2),
    ];

    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      outputFiles: files,
    });

    expect(result).toContain("前フェーズの出力（参照）");
    expect(result).toContain("1-plan.md");
    expect(result).toContain("2-code.md");
  });

  it("ジョブIDのラベルが含まれる", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "plan",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      outputFiles: [],
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
      jobFilePath: ".ccsquad/jobs/J000001.md",
      outputFiles: [],
      phasePrompt: "テストも必ず書くこと",
    });

    expect(result).toContain("## フェーズ指示");
    expect(result).toContain("テストも必ず書くこと");
  });

  it("ジョブ本文への記録セクションとジョブファイルパスが含まれる", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "plan",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      outputFiles: [],
    });

    expect(result).toContain("ジョブ本文への記録");
    expect(result).toContain(".ccsquad/jobs/J000001.md");
  });

  it("outputFormatが指定されるとジョブ本文記録にフォーマットが含まれる", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "analyze",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      outputFiles: [],
      outputFormat: ["## 調査結果", "## 影響範囲"],
    });

    expect(result).toContain("## 調査結果");
    expect(result).toContain("## 影響範囲");
  });

  it("outputFormatがnullの場合は汎用指示になる", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "task",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      outputFiles: [],
      outputFormat: null,
    });

    expect(result).toContain("実施した内容の要約");
    expect(result).toContain("重要な判断とその根拠");
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

  it("research タイプは task-like として扱われる", () => {
    const result = buildResumePrompt({
      phase: "analyze",
      phaseType: "research",
      iteration: 2,
      feedback: "調査が不十分",
    });

    expect(result).toContain("reject");
    expect(result).toContain("調査が不十分");
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
      jobFilePath: ".ccsquad/jobs/J000001.md",
      taskOutputFile: makeOutputFileRef("code", 2),
      outputFiles: [makeOutputFileRef("plan", 1), makeOutputFileRef("code", 2)],
    });

    expect(result).toContain("J000001");
    expect(result).toContain("レビュータスク");
    expect(result).toContain("review");
    expect(result).toContain("1");
    expect(result).toContain("レビューの説明");
    expect(result).toContain("レビュー対象");
    expect(result).toContain("2-code.md");
  });

  it("phaseDescription が設定されている場合含まれる", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      phaseDescription: "コードレビューを行う",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      taskOutputFile: makeOutputFileRef("code", 1),
      outputFiles: [makeOutputFileRef("code", 1)],
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
      jobFilePath: ".ccsquad/jobs/J000001.md",
      taskOutputFile: makeOutputFileRef("code", 1),
      outputFiles: [makeOutputFileRef("code", 1)],
    });

    expect(result).not.toContain("フェーズ説明:");
  });

  it("レビュー対象ファイルパスが含まれる", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      taskOutputFile: makeOutputFileRef("code", 2),
      outputFiles: [makeOutputFileRef("plan", 1), makeOutputFileRef("code", 2)],
    });

    expect(result).toContain("レビュー対象");
    expect(result).toContain("2-code.md");
  });

  it("レビュー対象以外の出力ファイルが参照セクションに含まれる", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      taskOutputFile: makeOutputFileRef("code", 2),
      outputFiles: [makeOutputFileRef("plan", 1), makeOutputFileRef("code", 2)],
    });

    expect(result).toContain("前フェーズの出力（参照）");
    expect(result).toContain("1-plan.md");
  });

  it("ジョブIDのラベルが含まれる", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      taskOutputFile: makeOutputFileRef("code", 1),
      outputFiles: [makeOutputFileRef("code", 1)],
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
      jobFilePath: ".ccsquad/jobs/J000001.md",
      taskOutputFile: makeOutputFileRef("code", 1),
      outputFiles: [makeOutputFileRef("code", 1)],
      phasePrompt: "セキュリティ観点でレビュー",
    });

    expect(result).toContain("## フェーズ指示");
    expect(result).toContain("セキュリティ観点でレビュー");
  });

  it("ジョブ本文への記録セクションとジョブファイルパスが含まれる", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      taskOutputFile: makeOutputFileRef("code", 1),
      outputFiles: [makeOutputFileRef("code", 1)],
    });

    expect(result).toContain("ジョブ本文への記録");
    expect(result).toContain(".ccsquad/jobs/J000001.md");
  });

  it("outputFiles が taskOutputFile のみの場合、前フェーズの出力（参照）が含まれない", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      taskOutputFile: makeOutputFileRef("code", 1),
      outputFiles: [makeOutputFileRef("code", 1)],
    });

    expect(result).not.toContain("前フェーズの出力（参照）");
  });

  it("taskOutputFile と同じファイルパスが参照セクションに含まれない", () => {
    const taskOutputFile = makeOutputFileRef("code", 2);
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      taskOutputFile,
      outputFiles: [makeOutputFileRef("plan", 1), makeOutputFileRef("code", 2)],
    });

    // plan は参照に含まれるが、taskOutputFile (code #2) は参照セクションに含まれない
    expect(result).toContain("1-plan.md");
    expect(result).not.toContain("前フェーズの出力（参照）\n\n過去のフェーズ出力は以下のファイルに保存されています。必要に応じて読み込んでください。\n\n- code (#2)");
    // 参照セクションに taskOutputFile のパスが含まれないことを明示確認
    const refsSection = result.split("## 前フェーズの出力（参照）");
    if (refsSection.length > 1) {
      expect(refsSection[1]).not.toContain("2-code.md");
    }
  });

  it("outputFormat あり → ジョブ本文記録にフォーマットが含まれる", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      taskOutputFile: makeOutputFileRef("code", 1),
      outputFiles: [makeOutputFileRef("code", 1)],
      outputFormat: ["## レビュー判定", "## 指摘事項"],
    });

    expect(result).toContain("## レビュー判定");
    expect(result).toContain("## 指摘事項");
  });

  it("outputFormat なし → 汎用指示", () => {
    const result = buildReviewPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "review",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      taskOutputFile: makeOutputFileRef("code", 1),
      outputFiles: [makeOutputFileRef("code", 1)],
    });

    expect(result).toContain("実施した内容の要約");
    expect(result).toContain("重要な判断とその根拠");
  });
});

// ─── buildResumePrompt 追加テスト ───────────────────────────────────────────────

describe("buildResumePrompt - plan/code task-like", () => {
  it('phaseType: "plan" → task-like として reject メッセージを含む', () => {
    const result = buildResumePrompt({
      phase: "plan",
      phaseType: "plan",
      iteration: 1,
      feedback: "計画が不十分です",
    });

    expect(result).toContain("reject");
    expect(result).toContain("修正してください");
    expect(result).toContain("計画が不十分です");
  });

  it('phaseType: "code" → task-like として reject メッセージを含む', () => {
    const result = buildResumePrompt({
      phase: "code",
      phaseType: "code",
      iteration: 2,
      feedback: "実装に不備があります",
    });

    expect(result).toContain("reject");
    expect(result).toContain("修正してください");
    expect(result).toContain("実装に不備があります");
  });
});

// ─── buildTaskPrompt 追加テスト ─────────────────────────────────────────────────

describe("buildTaskPrompt - outputFormat 空配列", () => {
  it("outputFormat が空配列 [] → 汎用指示", () => {
    const result = buildTaskPrompt({
      jobId: "J000001",
      title: "テスト",
      phase: "task",
      iteration: 1,
      jobBody: "本文",
      jobFilePath: ".ccsquad/jobs/J000001.md",
      outputFiles: [],
      outputFormat: [],
    });

    expect(result).toContain("実施した内容の要約");
    expect(result).toContain("重要な判断とその根拠");
  });
});
