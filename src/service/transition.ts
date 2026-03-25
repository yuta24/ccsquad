import type { WorkflowConfig, TransitionCondition, PhaseConfig } from "../config.js";
import type { Job, JobStore } from "../job.js";
import { appendPhaseLog } from "../job.js";
import type { IterationStore } from "../iteration.js";
import { CcsquadError } from "../error.js";

export type TransitionResult =
  | { type: "done"; jobId: string; status: string }
  | { type: "continue"; jobId: string; nextPhase: string; phaseConfig: PhaseConfig }
  | {
      type: "pause";
      jobId: string;
      nextPhase: string;
      phaseConfig: PhaseConfig;
      reason: "max_iterations" | "human_review";
    };

export function resolveAndExecuteTransition(
  wf: WorkflowConfig,
  store: JobStore,
  iterationStore: IterationStore,
  jobId: string,
  condition: TransitionCondition,
  message: string,
): TransitionResult {
  const job = store.load(jobId);
  // Normalize depends_on
  job.frontmatter.depends_on = job.frontmatter.depends_on ?? [];

  const phaseName = job.frontmatter.current_phase;
  if (!phaseName) {
    throw new CcsquadError("workflow", "現在のフェーズが設定されていません");
  }

  // Validate running state
  if (job.frontmatter.status !== "running") {
    throw new CcsquadError(
      "job",
      `ジョブ '${jobId}' は実行中ではありません (status: ${job.frontmatter.status})`,
    );
  }

  const phaseConfig = wf.getPhase(phaseName);
  if (!phaseConfig) {
    throw new CcsquadError("workflow", `フェーズ '${phaseName}' がワークフローに定義されていません`);
  }

  // Validate condition based on phase type
  if (phaseConfig.type === "review") {
    if (condition !== "approved" && condition !== "rejected") {
      throw new CcsquadError("workflow", "レビューフェーズでは approve/reject を使用してください");
    }
  } else {
    if (condition === "approved" || condition === "rejected") {
      throw new CcsquadError("workflow", "通常フェーズでは approve/reject を使用できません");
    }
  }

  const next = wf.resolveTransition(phaseName, condition);

  const executeTransition = (j: Job) => {
    appendPhaseLog(j, phaseName, condition, next, message);
    if (next === "COMPLETE") {
      j.frontmatter.status = "completed";
      j.frontmatter.current_phase = undefined;
    } else if (next === "ABORT") {
      j.frontmatter.status = "failed";
      j.frontmatter.current_phase = undefined;
    } else {
      j.frontmatter.current_phase = next;
    }
    j.frontmatter.updated_at = new Date().toISOString();
    store.save(j);
  };

  const recordLogOnly = (j: Job) => {
    appendPhaseLog(j, phaseName, condition, next, message);
    j.frontmatter.updated_at = new Date().toISOString();
    store.save(j);
  };

  // Terminal states
  if (next === "COMPLETE" || next === "ABORT") {
    executeTransition(job);
    iterationStore.remove(jobId);
    return { type: "done", jobId, status: job.frontmatter.status };
  }

  const nextPhaseConfig = wf.getPhase(next);
  if (!nextPhaseConfig) {
    throw new CcsquadError("workflow", `遷移先フェーズ '${next}' がワークフローに定義されていません`);
  }

  // Max iterations
  const currentIteration = iterationStore.get(jobId);
  if (currentIteration >= wf.maxIterations()) {
    recordLogOnly(job);
    return { type: "pause", jobId, nextPhase: next, phaseConfig: nextPhaseConfig, reason: "max_iterations" };
  }

  // Human review
  if (nextPhaseConfig.type === "review" && nextPhaseConfig.reviewer === "human") {
    executeTransition(job);
    iterationStore.increment(jobId);
    return { type: "pause", jobId, nextPhase: next, phaseConfig: nextPhaseConfig, reason: "human_review" };
  }

  // Auto-continue
  executeTransition(job);
  iterationStore.increment(jobId);
  return { type: "continue", jobId, nextPhase: next, phaseConfig: nextPhaseConfig };
}

export function validateConditionForPhase(
  wf: WorkflowConfig,
  phaseName: string,
  condition: TransitionCondition,
): void {
  const phaseConfig = wf.getPhase(phaseName);
  if (!phaseConfig) {
    throw new CcsquadError("workflow", `フェーズ '${phaseName}' がワークフローに定義されていません`);
  }

  if (phaseConfig.type === "review") {
    if (condition !== "approved" && condition !== "rejected") {
      throw new CcsquadError("workflow", "レビューフェーズでは approved/rejected を使用してください");
    }
  } else if (condition === "approved" || condition === "rejected") {
    throw new CcsquadError("workflow", "通常フェーズでは completed/failed を使用してください");
  }
}
