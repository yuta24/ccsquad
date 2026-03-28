import { CcsquadError } from "../error.js";
import type {
  WorkflowConfig,
  PhaseConfig,
  PhaseType,
  TransitionCondition,
  Diagnostic,
} from "./types.js";
import { ALL_CONDITIONS, ALL_PHASE_TYPES, TASK_LIKE_TYPES } from "./types.js";

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

export function maxIterations(wf: WorkflowConfig): number {
  return wf.max_iterations ?? 10;
}

// ── Utilities ──

export function isTaskLikeType(type: PhaseType): boolean {
  return TASK_LIKE_TYPES.includes(type);
}

export function getOutputFormat(phase: PhaseConfig): string[] | null {
  if (phase.output_format !== undefined) {
    return phase.output_format;
  }
  return DEFAULT_OUTPUT_FORMATS[phase.type];
}

export function parseTransitionCondition(s: string): TransitionCondition {
  if (ALL_CONDITIONS.includes(s as TransitionCondition)) {
    return s as TransitionCondition;
  }
  throw new CcsquadError("workflow", `不明な遷移条件です: ${s}`);
}

// ── Default output formats ──

const DEFAULT_OUTPUT_FORMATS: Record<PhaseType, string[] | null> = {
  task: null,
  research: ["## 調査結果", "## 影響範囲", "## 制約・リスク", "## 未解決事項"],
  plan: ["## 目的", "## 設計方針", "## タスク一覧", "## 受け入れ条件"],
  code: ["## 実装内容", "## 変更ファイル一覧", "## テスト結果"],
  review: ["## レビュー判定", "## 指摘事項", "## 改善提案"],
};

// ── Validation ──

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

// ── Lint ──

export function lint(wf: WorkflowConfig, workflowName: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (wf.phases.length === 0) {
    diagnostics.push({ severity: "error", workflow: workflowName, message: "フェーズが定義されていません" });
    return diagnostics;
  }

  const phaseNames = new Set(wf.phases.map((p) => p.name));

  for (const phase of wf.phases) {
    if (!ALL_PHASE_TYPES.includes(phase.type)) {
      diagnostics.push({
        severity: "error",
        workflow: workflowName,
        phase: phase.name,
        message: `type '${phase.type}' が不正です (${ALL_PHASE_TYPES.join(", ")} を指定してください)`,
      });
      continue;
    }

    for (const next of Object.values(phase.on)) {
      if (next !== "COMPLETE" && next !== "ABORT" && !phaseNames.has(next)) {
        diagnostics.push({
          severity: "error",
          workflow: workflowName,
          phase: phase.name,
          message: `遷移先 '${next}' が存在しません`,
        });
      }
    }

    if (phase.type === "review") {
      if (!phase.reviewer) {
        diagnostics.push({ severity: "error", workflow: workflowName, phase: phase.name, message: "reviewer が設定されていません" });
      }
      if (phase.agent) {
        diagnostics.push({ severity: "error", workflow: workflowName, phase: phase.name, message: "agent は設定できません" });
      }
      if (!phase.on["approved"]) {
        diagnostics.push({ severity: "error", workflow: workflowName, phase: phase.name, message: "'approved' ルールがありません" });
      }
      if (!phase.on["rejected"]) {
        diagnostics.push({ severity: "error", workflow: workflowName, phase: phase.name, message: "'rejected' ルールがありません" });
      }
    } else {
      if (!phase.agent) {
        diagnostics.push({ severity: "error", workflow: workflowName, phase: phase.name, message: "agent が設定されていません" });
      }
      if (phase.reviewer) {
        diagnostics.push({ severity: "error", workflow: workflowName, phase: phase.name, message: "reviewer は設定できません" });
      }
      if (!phase.on["completed"]) {
        diagnostics.push({ severity: "error", workflow: workflowName, phase: phase.name, message: "'completed' ルールがありません" });
      }
    }
  }

  // Detect unreachable phases
  const initial = wf.phases[0];
  const reachable = new Set<string>();
  const stack = [initial.name];
  while (stack.length > 0) {
    const phaseName = stack.pop()!;
    if (reachable.has(phaseName)) continue;
    reachable.add(phaseName);
    const phase = getPhase(wf, phaseName);
    if (phase) {
      for (const next of Object.values(phase.on)) {
        if (next !== "COMPLETE" && next !== "ABORT") {
          stack.push(next);
        }
      }
    }
  }

  for (const phase of wf.phases) {
    if (!reachable.has(phase.name)) {
      diagnostics.push({
        severity: "warning",
        workflow: workflowName,
        phase: phase.name,
        message: "到達不能なフェーズです",
      });
    }
  }

  return diagnostics;
}
