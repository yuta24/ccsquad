import { CcsquadError } from "../error.js";
import type { Job, WorkflowConfig, PhaseConfig, TransitionCondition } from "./types.js";
import { getPhase, resolveTransition, maxIterations, validateConditionForPhase } from "./workflow.js";

export type TransitionDecision =
  | { action: "complete"; newStatus: "completed" }
  | { action: "abort"; newStatus: "failed" }
  | { action: "continue"; nextPhase: string; nextPhaseConfig: PhaseConfig }
  | { action: "pause"; nextPhase: string; nextPhaseConfig: PhaseConfig; reason: "human_review" | "max_iterations" };

export interface TransitionInput {
  job: Job;
  workflow: WorkflowConfig;
  condition: TransitionCondition;
  currentIteration: number;
}

/**
 * Pure function: given current state, compute the transition decision.
 * No I/O, no saves, no side effects.
 */
export function computeTransition(input: TransitionInput): TransitionDecision {
  const { job, workflow, condition, currentIteration } = input;

  const phaseName = job.frontmatter.current_phase;
  if (!phaseName) {
    throw new CcsquadError("workflow", "現在のフェーズが設定されていません");
  }

  if (job.frontmatter.status !== "running") {
    throw new CcsquadError(
      "job",
      `ジョブ '${job.frontmatter.id}' は実行中ではありません (status: ${job.frontmatter.status})`,
    );
  }

  const phaseConfig = getPhase(workflow, phaseName);
  if (!phaseConfig) {
    throw new CcsquadError("workflow", `フェーズ '${phaseName}' がワークフローに定義されていません`);
  }

  // Validate condition for phase type
  validateConditionForPhase(phaseConfig.type, condition);

  const next = resolveTransition(workflow, phaseName, condition);

  // Terminal states
  if (next === "COMPLETE") {
    return { action: "complete", newStatus: "completed" };
  }
  if (next === "ABORT") {
    return { action: "abort", newStatus: "failed" };
  }

  const nextPhaseConfig = getPhase(workflow, next);
  if (!nextPhaseConfig) {
    throw new CcsquadError("workflow", `遷移先フェーズ '${next}' がワークフローに定義されていません`);
  }

  // Max iterations check
  if (currentIteration >= maxIterations(workflow)) {
    return { action: "pause", nextPhase: next, nextPhaseConfig, reason: "max_iterations" };
  }

  // Human review check
  if (nextPhaseConfig.type === "review" && nextPhaseConfig.reviewer === "human") {
    return { action: "pause", nextPhase: next, nextPhaseConfig, reason: "human_review" };
  }

  // Auto-continue
  return { action: "continue", nextPhase: next, nextPhaseConfig };
}
