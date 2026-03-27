import type { PhaseConfig } from "../config.js";
import { isTaskLikeType } from "../config.js";
import type { NodeOutput } from "../output.js";

const DEFAULT_MAX_CHARS = 50000;

function buildOutputFormatInstruction(contract: string[]): string {
  const sections = contract.map((s) => `- ${s}`).join("\n");
  return [
    "## 出力フォーマット（必須）",
    "",
    "あなたの出力には以下のセクションを **必ず** 含めてください:",
    "",
    sections,
    "",
    "各セクションは見出しで始め、簡潔かつ具体的に記載してください。",
  ].join("\n");
}

function buildJobUpdateInstruction(jobFilePath: string, phase: string): string {
  return [
    "## ジョブ本文への記録（必須）",
    "",
    `タスク完了時、以下の手順でジョブファイル \`${jobFilePath}\` の本文を更新してください。`,
    "",
    "1. ジョブファイルを読み込む",
    `2. 「## フェーズログ」セクションの **直前** に「## ${phase}」セクションを追加（既に存在する場合は内容を置換）`,
    "3. セクションには以下を簡潔に記載する:",
    "   - このフェーズで実施した内容の要約",
    "   - 重要な判断とその根拠",
    "   - 次フェーズに引き継ぐべきコンテキスト（発見事項、制約、未解決事項など）",
    "4. ファイルを保存する",
    "",
    "注意: frontmatter や他のセクションは変更しないこと。",
  ].join("\n");
}

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

export function buildTaskPrompt(params: {
  jobId: string;
  title: string;
  phase: string;
  phaseDescription?: string;
  phasePrompt?: string;
  iteration: number;
  jobBody: string;
  jobFilePath: string;
  previousOutputs: NodeOutput[];
  includeOutputPhases?: string[];
  outputFormat?: string[] | null;
}): string {
  const { jobId, title, phase, phaseDescription, phasePrompt, iteration, jobBody, jobFilePath, previousOutputs, includeOutputPhases, outputFormat } = params;

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

  const outputsToInclude = includeOutputPhases
    ? previousOutputs.filter((o) => includeOutputPhases.includes(o.phase))
    : previousOutputs.length > 0
      ? [previousOutputs[previousOutputs.length - 1]]
      : [];

  if (outputsToInclude.length > 0) {
    parts.push("");
    parts.push("## 前フェーズの出力");
    for (const output of outputsToInclude) {
      const truncated = truncateOutput(output.content);
      parts.push(`### ${output.phase} (イテレーション ${output.iteration})`);
      parts.push(truncated);
    }
  }

  if (outputFormat && outputFormat.length > 0) {
    parts.push("");
    parts.push(buildOutputFormatInstruction(outputFormat));
  }

  parts.push("");
  parts.push(buildJobUpdateInstruction(jobFilePath, phase));

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
  taskOutput: string;
  previousOutputs?: NodeOutput[];
  includeOutputPhases?: string[];
  outputFormat?: string[] | null;
}): string {
  const { jobId, title, phase, phaseDescription, phasePrompt, iteration, jobBody, jobFilePath, taskOutput, previousOutputs, includeOutputPhases, outputFormat } = params;

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

  if (includeOutputPhases && previousOutputs) {
    const relatedOutputs = previousOutputs.filter(
      (o) => includeOutputPhases.includes(o.phase) && o.content !== taskOutput,
    );
    if (relatedOutputs.length > 0) {
      parts.push("");
      parts.push("## 参考: 関連フェーズの出力");
      for (const output of relatedOutputs) {
        const truncated = truncateOutput(output.content);
        parts.push(`### ${output.phase} (イテレーション ${output.iteration})`);
        parts.push(truncated);
      }
    }
  }

  parts.push("");
  parts.push("## レビュー対象");
  parts.push(taskOutput);

  if (outputFormat && outputFormat.length > 0) {
    parts.push("");
    parts.push(buildOutputFormatInstruction(outputFormat));
  }

  parts.push("");
  parts.push(buildJobUpdateInstruction(jobFilePath, phase));

  return parts.join("\n");
}
