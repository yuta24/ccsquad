import { readFileSync } from "node:fs";
import type { SquadConfig } from "../config.js";
import { parseTransitionCondition } from "../config.js";
import { JobStore } from "../job.js";
import { IterationStore } from "../iteration.js";
import { CurrentJobsStore } from "../current-jobs.js";
import { CcsquadError } from "../error.js";
import { resolveAndExecuteTransition } from "../service/transition.js";

export interface AgentResult {
  job_id: string;
  result: string;
  message: string;
}

export function extractResult(message: string): AgentResult | null {
  const lines = message.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("{") && trimmed.includes('"result"')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof parsed.job_id === "string") {
          return {
            job_id: parsed.job_id,
            result: typeof parsed.result === "string" ? parsed.result : "",
            message: typeof parsed.message === "string" ? parsed.message : "",
          };
        }
      } catch {
        // not valid JSON, continue
      }
    }
  }
  return null;
}

interface SubagentStopInput {
  last_assistant_message?: string;
}

export function cmdOnAgentComplete(config: SquadConfig, jobsDir: string, squadDir: string): void {
  const currentJobs = new CurrentJobsStore(squadDir);

  if (currentJobs.list().length === 0) {
    return;
  }

  let input: string;
  try {
    input = readFileSync(0, "utf-8");
  } catch {
    input = "";
  }

  let hookInput: SubagentStopInput;
  try {
    hookInput = JSON.parse(input) as SubagentStopInput;
  } catch {
    hookInput = {};
  }

  const lastMsg = hookInput.last_assistant_message;
  if (!lastMsg || lastMsg.length === 0) {
    console.log("[CCSQUAD] エージェント出力を取得できませんでした。");
    console.log("手動で ccsquad job transition <ID> <result> --message '<msg>' を実行してください。");
    return;
  }

  const agentResult = extractResult(lastMsg);
  if (!agentResult) {
    console.log("[CCSQUAD] エージェント出力から結果を取得できませんでした。");
    console.log("手動で ccsquad job transition <ID> <result> --message '<msg>' を実行してください。");
    return;
  }

  const { job_id: jobId, result, message } = agentResult;

  if (!currentJobs.contains(jobId)) {
    console.log(`[CCSQUAD] ジョブ ${jobId} はアクティブジョブに登録されていません。スキップします。`);
    return;
  }

  const store = new JobStore(jobsDir);
  const iterationStore = new IterationStore(squadDir);

  const job = store.load(jobId);
  const wf = config.getWorkflow(job.frontmatter.workflow);
  if (!wf) {
    throw new CcsquadError("config", `ワークフロー '${job.frontmatter.workflow}' が ccsquad.yaml に定義されていません`);
  }

  const condition = parseTransitionCondition(result);
  const txResult = resolveAndExecuteTransition(wf, store, iterationStore, jobId, condition, message);

  switch (txResult.type) {
    case "done": {
      currentJobs.remove(jobId);
      const updated = store.load(jobId);
      console.log(`[CCSQUAD] ジョブ ${jobId} が${updated.frontmatter.status}しました。`);
      break;
    }
    case "pause": {
      currentJobs.remove(jobId);
      const desc = txResult.phaseConfig.description ?? "";
      if (txResult.reason === "pause") {
        console.log("[CCSQUAD] フェーズ遷移完了。一時停止しました。");
      } else if (txResult.reason === "max_iterations") {
        console.log("[CCSQUAD] フェーズ遷移完了。イテレーション上限に達しました。");
      } else {
        console.log("[CCSQUAD] フェーズ遷移完了。レビュー待ちです。");
      }
      console.log(`ジョブ ID: ${jobId} | 次フェーズ: ${txResult.nextPhase} | 説明: ${desc}`);
      console.log(`確認後 /job-approve ${jobId} で続行、/job-reject ${jobId} で却下できます。`);
      break;
    }
    case "continue": {
      const agent = txResult.phaseConfig.agent ?? "unknown";
      const desc = txResult.phaseConfig.description ?? "";
      console.log("[CCSQUAD] フェーズ遷移完了。次のフェーズを自動実行します。");
      console.log(`Agent ツールで subagent_type="${agent}" のサブエージェントを起動してください。`);
      console.log(`ジョブ ID: ${jobId} | フェーズ: ${txResult.nextPhase} | 説明: ${desc}`);
      console.log(`プロンプトは ccsquad job show ${jobId} --format json で取得し、job-run スキルと同じ形式で注入してください。`);
      break;
    }
  }
}
