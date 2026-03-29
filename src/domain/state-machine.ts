import { CcsquadError } from "../error.js";
import type { Job, WorkflowConfig, PhaseConfig, TransitionCondition } from "./types.js";
import { getPhase, resolveTransition, validateConditionForPhase } from "./workflow.js";

export type TransitionDecision =
  | { action: "complete"; newStatus: "completed" }
  | { action: "abort"; newStatus: "failed" }
  | { action: "continue"; nextPhase: string; nextPhaseConfig: PhaseConfig }
  | { action: "pause"; nextPhase: string; nextPhaseConfig: PhaseConfig; reason: "human_review" | "max_iterations" };

export interface TransitionInput {
  job: Job;
  workflow: WorkflowConfig;
  condition: TransitionCondition;
}

const AC_HEADING_RE = /^##\s+Acceptance\s+Criteria/mi;

/**
 * Pure function: given current state, compute the transition decision.
 * No I/O, no saves, no side effects.
 */
export function computeTransition(input: TransitionInput): TransitionDecision {
  const { job, workflow, condition } = input;

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

  // Acceptance Criteria guard: block transition into execute phase without AC
  if (nextPhaseConfig.type === "execute" && !AC_HEADING_RE.test(job.body)) {
    throw new CcsquadError(
      "workflow",
      `execute フェーズ '${next}' への遷移には Acceptance Criteria が必要です。ジョブ body に '## Acceptance Criteria' セクションを追加してください`,
    );
  }

  // Human review check (review phase pauses unless auto is enabled)
  // Review pauses take priority over max_iterations — humans must always be able to approve/reject.
  if (nextPhaseConfig.type === "review" && !nextPhaseConfig.auto) {
    return { action: "pause", nextPhase: next, nextPhaseConfig, reason: "human_review" };
  }

  // Max iterations check
  if (job.frontmatter.iteration >= job.frontmatter.max_iterations) {
    return { action: "pause", nextPhase: next, nextPhaseConfig, reason: "max_iterations" };
  }

  // Auto-continue
  return { action: "continue", nextPhase: next, nextPhaseConfig };
}
