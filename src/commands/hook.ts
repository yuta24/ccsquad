import { readFileSync } from "node:fs";
import type { SquadConfig } from "../config.js";
import { parseTransitionCondition } from "../config.js";
import { JobStore, appendPhaseLog } from "../job.js";
import { IterationStore } from "../iteration.js";
import { CurrentJobsStore } from "../current-jobs.js";
import { WorkflowEngine } from "../engine.js";
import { CcsquadError } from "../error.js";

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

  // アクティブジョブが存在しなければ何もしない
  if (currentJobs.list().length === 0) {
    return;
  }

  // stdin から SubagentStop の JSON を読み取る
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

  // last_assistant_message から結果 JSON 行を抽出
  const agentResult = extractResult(lastMsg);
  if (!agentResult) {
    console.log("[CCSQUAD] エージェント出力から結果を取得できませんでした。");
    console.log("手動で ccsquad job transition <ID> <result> --message '<msg>' を実行してください。");
    return;
  }

  const { job_id: jobId, result, message } = agentResult;

  // アクティブジョブに含まれているか検証
  if (!currentJobs.contains(jobId)) {
    console.log(`[CCSQUAD] ジョブ ${jobId} はアクティブジョブに登録されていません。スキップします。`);
    return;
  }

  const store = new JobStore(jobsDir);
  const iterationStore = new IterationStore(squadDir);

  const job = store.load(jobId);
  const wf = config.getWorkflow(job.frontmatter.workflow);
  if (!wf) {
    throw new CcsquadError(
      "config",
      `ワークフロー '${job.frontmatter.workflow}' が ccsquad.yaml に定義されていません`,
    );
  }

  const phaseName = job.frontmatter.current_phase;
  if (!phaseName) {
    throw new CcsquadError("workflow", "現在のフェーズが設定されていません");
  }

  const phaseConfig = wf.getPhase(phaseName);
  if (!phaseConfig) {
    throw new CcsquadError("workflow", `フェーズ '${phaseName}' がワークフローに定義されていません`);
  }

  // 遷移先を解決
  const condition = parseTransitionCondition(result);
  const next = wf.resolveTransition(phaseName, condition);

  if (next === "COMPLETE" || next === "ABORT") {
    // 遷移実行
    const engine = new WorkflowEngine(wf, store);
    if (phaseConfig.reviewer !== undefined) {
      if (condition === "approved") {
        engine.approve(jobId, message);
      } else {
        engine.reject(jobId, message);
      }
    } else {
      engine.transition(jobId, condition, message);
    }
    const updatedJob = store.load(jobId);
    iterationStore.remove(jobId);
    currentJobs.remove(jobId);
    console.log(`[CCSQUAD] ジョブ ${jobId} が${updatedJob.frontmatter.status}しました。`);
  } else {
    const nextPhase = wf.getPhase(next);
    if (!nextPhase) {
      throw new CcsquadError("workflow", `遷移先フェーズ '${next}' がワークフローに定義されていません`);
    }

    if (nextPhase.pause) {
      // 遷移しない。フェーズログだけ記録
      const updatedJob = store.load(jobId);
      appendPhaseLog(updatedJob, phaseName, condition, next, message);
      updatedJob.frontmatter.updated_at = new Date().toISOString();
      store.save(updatedJob);
      currentJobs.remove(jobId);
      const desc = nextPhase.description ?? "";
      console.log("[CCSQUAD] フェーズ遷移完了。一時停止しました。");
      console.log(`ジョブ ID: ${jobId} | 次フェーズ: ${next} | 説明: ${desc}`);
      console.log(`確認後 /job-approve ${jobId} で続行、/job-reject ${jobId} で却下できます。`);
    } else {
      const currentIteration = iterationStore.get(jobId);
      if (currentIteration >= wf.maxIterations()) {
        // 遷移しない。フェーズログだけ記録
        const updatedJob = store.load(jobId);
        appendPhaseLog(updatedJob, phaseName, condition, next, message);
        updatedJob.frontmatter.updated_at = new Date().toISOString();
        store.save(updatedJob);
        currentJobs.remove(jobId);
        console.log("[CCSQUAD] フェーズ遷移完了。イテレーション上限に達しました。");
        console.log(`ジョブ ID: ${jobId} | 次フェーズ: ${next}`);
        console.log(`確認後 /job-approve ${jobId} で続行できます。`);
      } else {
        // 遷移実行（アクティブ登録は維持）
        const engine = new WorkflowEngine(wf, store);
        if (phaseConfig.reviewer !== undefined) {
          if (condition === "approved") {
            engine.approve(jobId, message);
          } else {
            engine.reject(jobId, message);
          }
        } else {
          engine.transition(jobId, condition, message);
        }
        iterationStore.increment(jobId);
        const agent = nextPhase.agent ?? "unknown";
        const desc = nextPhase.description ?? "";
        console.log("[CCSQUAD] フェーズ遷移完了。次のフェーズを自動実行します。");
        console.log(`Agent ツールで subagent_type="${agent}" のサブエージェントを起動してください。`);
        console.log(`ジョブ ID: ${jobId} | フェーズ: ${next} | 説明: ${desc}`);
        console.log(
          `プロンプトは ccsquad job show ${jobId} --format json で取得し、job-run スキルと同じ形式で注入してください。`,
        );
      }
    }
  }
}
