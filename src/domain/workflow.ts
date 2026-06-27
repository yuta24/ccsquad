import YAML from "yaml";
import { CcsquadError } from "../error.js";
import type {
  WorkflowConfig,
  PhaseConfig,
  PhaseType,
  TransitionCondition,
} from "./types.js";
import { ALL_CONDITIONS, ALL_PHASE_TYPES } from "./types.js";

// ── Workflow presets ──

export const WORKFLOW_PRESETS: Record<string, string> = {
  basic: `
plan:
  type: plan
  on:
    completed: execute
    failed: ABORT
execute:
  type: execute
  on:
    completed: review
    failed: plan
review:
  type: review
  on:
    approved: COMPLETE
    rejected: execute
`.trim(),

  develop: `
plan:
  type: plan
  on:
    completed: execute
    failed: ABORT
execute:
  type: execute
  on:
    completed: review
    failed: plan
review:
  type: review
  auto: true
  on:
    approved: COMPLETE
    rejected: execute
`.trim(),

  simple: `
execute:
  type: execute
  on:
    completed: review
    failed: ABORT
review:
  type: review
  on:
    approved: COMPLETE
    rejected: execute
`.trim(),

  gated: `
plan:
  type: plan
  on:
    completed: plan_gate
    failed: ABORT
plan_gate:
  type: review
  on:
    approved: execute
    rejected: plan
execute:
  type: execute
  on:
    completed: review
    failed: plan
review:
  type: review
  auto: true
  on:
    approved: COMPLETE
    rejected: execute
`.trim(),
};

// ── Query functions ──

export function initialPhase(wf: WorkflowConfig): PhaseConfig {
  if (wf.phases.length === 0) {
    throw new CcsquadError("config", "ワークフローにフェーズが定義されていません");
  }
  return wf.phases[0];
}

export function getPhase(wf: WorkflowConfig, name: string): PhaseConfig | undefined {
  return wf.phases.find((p) => p.name === name);
}

export function resolveTransition(
  wf: WorkflowConfig,
  phaseName: string,
  condition: TransitionCondition,
): string {
  const phase = getPhase(wf, phaseName);
  if (!phase) {
    throw new CcsquadError("workflow", `フェーズ '${phaseName}' がワークフローに定義されていません`);
  }
  const next = phase.on[condition];
  if (next === undefined) {
    throw new CcsquadError(
      "workflow",
      `フェーズ '${phaseName}' に条件 '${condition}' に一致するルールがありません`,
    );
  }
  return next;
}

// ── Utilities ──

export function parseTransitionCondition(s: string): TransitionCondition {
  if (ALL_CONDITIONS.includes(s as TransitionCondition)) {
    return s as TransitionCondition;
  }
  throw new CcsquadError("workflow", `不明な遷移条件です: ${s}`);
}

export function validateConditionForPhase(
  phaseType: PhaseType,
  condition: TransitionCondition,
): void {
  if (phaseType === "review") {
    if (condition !== "approved" && condition !== "rejected") {
      throw new CcsquadError("workflow", "レビューフェーズでは approved/rejected を使用してください");
    }
  } else if (condition === "approved" || condition === "rejected") {
    throw new CcsquadError("workflow", "通常フェーズでは completed/failed を使用してください");
  }
}

// ── Workflow parser (from raw object, e.g. frontmatter YAML) ──

export function parseWorkflowObject(parsed: unknown): WorkflowConfig {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CcsquadError("workflow", "workflow はオブジェクトで指定してください");
  }

  const phases: PhaseConfig[] = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      throw new CcsquadError("workflow", `不正なフェーズ定義です: ${name}`);
    }
    const entry = value as Record<string, unknown>;

    const type = String(entry.type ?? "");
    if (!ALL_PHASE_TYPES.includes(type as PhaseType)) {
      throw new CcsquadError("workflow", `不正なフェーズタイプ: ${type} (${ALL_PHASE_TYPES.join(", ")} を指定してください)`);
    }

    const agent = entry.agent != null ? String(entry.agent) : undefined;

    const auto = entry.auto === true ? true : undefined;

    const onRaw = entry.on;
    if (typeof onRaw !== "object" || onRaw === null) {
      throw new CcsquadError("workflow", `フェーズ '${name}' に on (遷移ルール) が定義されていません`);
    }

    const on: Partial<Record<TransitionCondition, string>> = {};
    for (const [cond, target] of Object.entries(onRaw as Record<string, unknown>)) {
      if (!ALL_CONDITIONS.includes(cond as TransitionCondition)) {
        throw new CcsquadError("workflow", `不明な遷移条件です: ${cond}`);
      }
      on[cond as TransitionCondition] = String(target);
    }

    phases.push({ name, type: type as PhaseType, agent, ...(auto ? { auto } : {}), on });
  }

  if (phases.length === 0) {
    throw new CcsquadError("workflow", "workflow にフェーズが定義されていません");
  }

  const phaseNames = new Set(phases.map((p) => p.name));
  for (const phase of phases) {
    for (const target of Object.values(phase.on)) {
      if (target !== "COMPLETE" && target !== "ABORT" && !phaseNames.has(target)) {
        throw new CcsquadError(
          "workflow",
          `フェーズ '${phase.name}' の遷移先 '${target}' は存在しないフェーズです`,
        );
      }
    }
  }

  return { phases };
}
