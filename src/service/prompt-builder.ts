import { isTaskLikeType } from "../config.js";

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

function buildJobUpdateInstruction(jobFilePath: string, phase: string, outputFormat?: string[] | null): string {
  const formatLines = outputFormat && outputFormat.length > 0
    ? [
        "3. セクションは以下の構成で記載する:",
        ...outputFormat.map((s) => `   - ${s}`),
      ]
    : [
        "3. セクションには以下を簡潔に記載する:",
        "   - このフェーズで実施した内容の要約",
        "   - 重要な判断とその根拠",
        "   - 次フェーズに引き継ぐべきコンテキスト（発見事項、制約、未解決事項など）",
      ];

  return [
    "## ジョブ本文への記録（必須）",
    "",
    `タスク完了時、以下の手順でジョブファイル \`${jobFilePath}\` の本文を更新してください。`,
    "",
    "1. ジョブファイルを読み込む",
    `2. 「## フェーズログ」セクションの **直前** に「## ${phase}」セクションを追加（既に存在する場合は内容を置換）`,
    ...formatLines,
    "4. 各セクションは簡潔かつ具体的に記載する",
    "5. ファイルを保存する",
    "",
    "注意: frontmatter や他のセクションは変更しないこと。",
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
  jobFilePath: string;
  outputFiles: OutputFileRef[];
  outputFormat?: string[] | null;
}): string {
  const { jobId, title, phase, phaseDescription, phasePrompt, iteration, jobBody, jobFilePath, outputFiles, outputFormat } = params;

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

  parts.push("");
  parts.push(buildJobUpdateInstruction(jobFilePath, phase, outputFormat));

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

  if (isTaskLikeType(phaseType as import("../config.js").PhaseType)) {
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

export function buildReviewPrompt(params: {
  jobId: string;
  title: string;
  phase: string;
  phaseDescription?: string;
  phasePrompt?: string;
  iteration: number;
  jobBody: string;
  jobFilePath: string;
  taskOutputFile: OutputFileRef;
  outputFiles: OutputFileRef[];
  outputFormat?: string[] | null;
}): string {
  const { jobId, title, phase, phaseDescription, phasePrompt, iteration, jobBody, jobFilePath, taskOutputFile, outputFiles, outputFormat } = params;

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

  // Reference to the output being reviewed
  parts.push("");
  parts.push("## レビュー対象");
  parts.push(`以下のファイルに記載された出力をレビューしてください: \`${taskOutputFile.filePath}\``);

  // Other output files for reference
  const otherFiles = outputFiles.filter((f) => f.filePath !== taskOutputFile.filePath);
  const refsSection = buildOutputReferencesSection(otherFiles);
  if (refsSection) {
    parts.push("");
    parts.push(refsSection);
  }

  parts.push("");
  parts.push(buildJobUpdateInstruction(jobFilePath, phase, outputFormat));

  return parts.join("\n");
}
