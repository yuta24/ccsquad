import type { NodeOutput } from "../output.js";

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

export function buildTaskPrompt(params: {
  jobId: string;
  title: string;
  phase: string;
  phaseDescription?: string;
  iteration: number;
  jobBody: string;
  previousOutputs: NodeOutput[];
}): string {
  const { jobId, title, phase, phaseDescription, iteration, jobBody, previousOutputs } = params;

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

  if (previousOutputs.length > 0) {
    const lastOutput = previousOutputs[previousOutputs.length - 1];
    const truncated = truncateOutput(lastOutput.content);

    parts.push("");
    parts.push("## 前フェーズの出力");
    parts.push(`### ${lastOutput.phase} (イテレーション ${lastOutput.iteration})`);
    parts.push(truncated);
  }

  return parts.join("\n");
}

export function buildResumePrompt(params: {
  phase: string;
  phaseType: "task" | "review";
  iteration: number;
  feedback: string;
}): string {
  const { phaseType, iteration, feedback } = params;

  if (phaseType === "task") {
    return [
      "以下の理由で reject されました。修正してください。",
      "",
      `イテレーション: ${iteration}`,
      "",
      "## reject 理由",
      feedback,
    ].join("\n");
  }

  return [
    "前回の指摘を受けて修正が行われました。再レビューしてください。",
    "",
    `イテレーション: ${iteration}`,
    "",
    "## 修正後の実行結果",
    feedback,
  ].join("\n");
}

export function buildReviewPrompt(params: {
  jobId: string;
  title: string;
  phase: string;
  phaseDescription?: string;
  iteration: number;
  jobBody: string;
  taskOutput: string;
}): string {
  const { jobId, title, phase, phaseDescription, iteration, jobBody, taskOutput } = params;

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
  parts.push("");
  parts.push("## レビュー対象");
  parts.push(taskOutput);

  return parts.join("\n");
}
