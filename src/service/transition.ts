import type { WorkflowConfig, TransitionCondition, PhaseConfig } from "../config.js";
import { parseTransitionCondition } from "../config.js";
import type { JobStore } from "../job.js";
import { appendPhaseLog } from "../job.js";
import { WorkflowEngine } from "../engine.js";
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
      reason: "pause" | "max_iterations" | "human_review";
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
  const phaseName = job.frontmatter.current_phase;
  if (!phaseName) {
    throw new CcsquadError("workflow", "現在のフェーズが設定されていません");
  }
  const phaseConfig = wf.getPhase(phaseName);
  if (!phaseConfig) {
    throw new CcsquadError("workflow", `フェーズ '${phaseName}' がワークフローに定義されていません`);
  }

  const next = wf.resolveTransition(phaseName, condition);

  const executeEngineTransition = () => {
    const engine = new WorkflowEngine(wf, store);
    if (phaseConfig.reviewer !== undefined) {
      condition === "approved" ? engine.approve(jobId, message) : engine.reject(jobId, message);
    } else {
      engine.transition(jobId, condition, message);
    }
  };

  const recordLogOnly = () => {
    const jobToUpdate = store.load(jobId);
    appendPhaseLog(jobToUpdate, phaseName, condition, next, message);
    jobToUpdate.frontmatter.updated_at = new Date().toISOString();
    store.save(jobToUpdate);
  };

  // Terminal states
  if (next === "COMPLETE" || next === "ABORT") {
    executeEngineTransition();
    const updated = store.load(jobId);
    iterationStore.remove(jobId);
    return { type: "done", jobId, status: updated.frontmatter.status };
  }

  const nextPhase = wf.getPhase(next);
  if (!nextPhase) {
    throw new CcsquadError("workflow", `遷移先フェーズ '${next}' がワークフローに定義されていません`);
  }

  // Pause flag
  if (nextPhase.pause) {
    recordLogOnly();
    return { type: "pause", jobId, nextPhase: next, phaseConfig: nextPhase, reason: "pause" };
  }

  // Max iterations
  const currentIteration = iterationStore.get(jobId);
  if (currentIteration >= wf.maxIterations()) {
    recordLogOnly();
    return { type: "pause", jobId, nextPhase: next, phaseConfig: nextPhase, reason: "max_iterations" };
  }

  // Human review
  if (nextPhase.reviewer === "human") {
    executeEngineTransition();
    iterationStore.increment(jobId);
    return { type: "pause", jobId, nextPhase: next, phaseConfig: nextPhase, reason: "human_review" };
  }

  // Auto-continue
  executeEngineTransition();
  iterationStore.increment(jobId);
  return { type: "continue", jobId, nextPhase: next, phaseConfig: nextPhase };
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

  if (phaseConfig.reviewer !== undefined) {
    if (condition !== "approved" && condition !== "rejected") {
      throw new CcsquadError("workflow", "レビューフェーズでは approved/rejected を使用してください");
    }
  } else if (condition === "approved" || condition === "rejected") {
    throw new CcsquadError("workflow", "通常フェーズでは completed/failed を使用してください");
  }
}
