import { isTaskLikeType } from "../domain/workflow.js";
import type { PhaseType } from "../domain/types.js";

const DEFAULT_MAX_CHARS = 50000;

export function truncateOutput(content: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  if (content.length <= maxChars) {
    return content;
  }

  const headChars = Math.floor(maxChars * 0.3);
  const tailChars = Math.floor(maxChars * 0.7);
  const omitted = content.length - headChars - tailChars;

  const head = content.slice(0, headChars);
  const tail = content.slice(content.length - tailChars);

  return `${head}\n\n... (${omitted} 文字省略) ...\n\n${tail}`;
}

export interface OutputFileRef {
  seq: number;
  phase: string;
  filePath: string;
}

function buildOutputFormatInstruction(outputFormat: string[]): string {
  return [
    "## 出力フォーマット（必須）",
    "",
    "あなたの最終出力には以下のセクションを **必ず** 含めてください。",
    "この出力はジョブの記録として保存され、後続フェーズのコンテキストになります。",
    "",
    ...outputFormat.map((s) => `- ${s}`),
    "",
    "各セクションは見出しで始め、簡潔かつ具体的に記載してください。",
  ].join("\n");
}

function buildOutputReferencesSection(outputFiles: OutputFileRef[]): string {
  if (outputFiles.length === 0) return "";

  const lines = [
    "## 前フェーズの出力（参照）",
    "",
    "過去のフェーズ出力は以下のファイルに保存されています。必要に応じて読み込んでください。",
    "",
    ...outputFiles.map((f) => `- ${f.phase} (#${f.seq}): \`${f.filePath}\``),
  ];
  return lines.join("\n");
}

export function buildTaskPrompt(params: {
  jobId: string;
  title: string;
  phase: string;
  phaseDescription?: string;
  phasePrompt?: string;
  iteration: number;
  jobBody: string;
  outputFiles: OutputFileRef[];
  outputFormat?: string[] | null;
}): string {
  const { jobId, title, phase, phaseDescription, phasePrompt, iteration, jobBody, outputFiles, outputFormat } = params;

  const parts: string[] = [
    `ジョブID: ${jobId}`,
    `タイトル: ${title}`,
    `フェーズ: ${phase}`,
  ];

  if (phaseDescription) {
    parts.push(`フェーズ説明: ${phaseDescription}`);
  }

  parts.push(`イテレーション: ${iteration}`);
  parts.push("");
  parts.push(jobBody);

  if (phasePrompt) {
    parts.push("");
    parts.push("## フェーズ指示");
    parts.push(phasePrompt);
  }

  const refsSection = buildOutputReferencesSection(outputFiles);
  if (refsSection) {
    parts.push("");
    parts.push(refsSection);
  }

  if (outputFormat && outputFormat.length > 0) {
    parts.push("");
    parts.push(buildOutputFormatInstruction(outputFormat));
  }

  return parts.join("\n");
}

export function buildResumePrompt(params: {
  phase: string;
  phaseType: string;
  phasePrompt?: string;
  iteration: number;
  feedback: string;
}): string {
  const { phaseType, phasePrompt, iteration, feedback } = params;

  if (isTaskLikeType(phaseType as PhaseType)) {
    return [
      "以下の理由で reject されました。修正してください。",
      "",
      `イテレーション: ${iteration}`,
      "",
      "## reject 理由",
      feedback,
      ...(phasePrompt ? ["", "## フェーズ指示", phasePrompt] : []),
    ].join("\n");
  }

  return [
    "前回の指摘を受けて修正が行われました。再レビューしてください。",
    "",
    `イテレーション: ${iteration}`,
    "",
    "## 修正後の実行結果",
    feedback,
    ...(phasePrompt ? ["", "## フェーズ指示", phasePrompt] : []),
  ].join("\n");
}

export function buildPlanCreateSystemPrompt(workflows: string[]): string {
  return [
    "あなたは要件分析とタスク分解の専門家です。",
    "ユーザーと対話しながら要件を整理し、具体的なジョブに分解してください。",
    "",
    "## 作業の流れ",
    "1. ユーザーの要求を深掘りし、要件を明確化する",
    "2. タスクに分解し、依存関係を整理する",
    "3. `ccsquad job add` コマンドでジョブを作成する",
    "",
    "## ジョブ作成コマンド",
    "```",
    'ccsquad job add "タイトル" --workflow <workflow> [--description "説明"] [--priority N] [--depends-on ID1,ID2]',
    "```",
    "",
    "## 利用可能なワークフロー",
    ...workflows.map((w) => `- ${w}`),
    "",
    "## 注意点",
    "- 1ジョブ = 1つの明確な成果物",
    "- 依存関係を明示する",
    "- ジョブ作成前にユーザーに確認を取る",
  ].join("\n");
}

export function buildReviewPrompt(params: {
  jobId: string;
  title: string;
  phase: string;
  phaseDescription?: string;
  phasePrompt?: string;
  iteration: number;
  jobBody: string;
  taskOutputFile: OutputFileRef;
  outputFiles: OutputFileRef[];
  outputFormat?: string[] | null;
}): string {
  const { jobId, title, phase, phaseDescription, phasePrompt, iteration, jobBody, taskOutputFile, outputFiles, outputFormat } = params;

  const parts: string[] = [
    `ジョブID: ${jobId}`,
    `タイトル: ${title}`,
    `フェーズ: ${phase}`,
  ];

  if (phaseDescription) {
    parts.push(`フェーズ説明: ${phaseDescription}`);
  }

  parts.push(`イテレーション: ${iteration}`);
  parts.push("");
  parts.push(jobBody);

  if (phasePrompt) {
    parts.push("");
    parts.push("## フェーズ指示");
    parts.push(phasePrompt);
  }

  parts.push("");
  parts.push("## レビュー対象");
  parts.push(`以下のファイルに記載された出力をレビューしてください: \`${taskOutputFile.filePath}\``);

  const otherFiles = outputFiles.filter((f) => f.filePath !== taskOutputFile.filePath);
  const refsSection = buildOutputReferencesSection(otherFiles);
  if (refsSection) {
    parts.push("");
    parts.push(refsSection);
  }

  if (outputFormat && outputFormat.length > 0) {
    parts.push("");
    parts.push(buildOutputFormatInstruction(outputFormat));
  }

  return parts.join("\n");
}
