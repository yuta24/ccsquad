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
  phasePrompt?: string;
  iteration: number;
  jobBody: string;
  previousOutputs: NodeOutput[];
  includeOutputPhases?: string[];
}): string {
  const { jobId, title, phase, phaseDescription, phasePrompt, iteration, jobBody, previousOutputs, includeOutputPhases } = params;

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

  return parts.join("\n");
}

export function buildResumePrompt(params: {
  phase: string;
  phaseType: "task" | "review";
  phasePrompt?: string;
  iteration: number;
  feedback: string;
}): string {
  const { phaseType, phasePrompt, iteration, feedback } = params;

  if (phaseType === "task") {
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
  taskOutput: string;
  previousOutputs?: NodeOutput[];
  includeOutputPhases?: string[];
}): string {
  const { jobId, title, phase, phaseDescription, phasePrompt, iteration, jobBody, taskOutput, previousOutputs, includeOutputPhases } = params;

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

  return parts.join("\n");
}
