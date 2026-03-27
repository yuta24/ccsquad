import { readFileSync } from "fs";
import { parse } from "yaml";
import { CcsquadError } from "./error.js";

export type TransitionCondition = "completed" | "failed" | "rejected" | "approved";
export type PhaseType = "task" | "research" | "plan" | "code" | "review";

const ALL_CONDITIONS: TransitionCondition[] = ["completed", "failed", "rejected", "approved"];
const ALL_PHASE_TYPES: PhaseType[] = ["task", "research", "plan", "code", "review"];

// task-like types use completed/failed transitions and require agent
const TASK_LIKE_TYPES: PhaseType[] = ["task", "research", "plan", "code"];

export function isTaskLikeType(type: PhaseType): boolean {
  return TASK_LIKE_TYPES.includes(type);
}

// Default output contracts per phase type
const DEFAULT_OUTPUT_FORMATS: Record<PhaseType, string[] | null> = {
  task: null,  // generic, no contract
  research: [
    "## 調査結果",
    "## 影響範囲",
    "## 制約・リスク",
    "## 未解決事項",
  ],
  plan: [
    "## 目的",
    "## 設計方針",
    "## タスク一覧",
    "## 受け入れ条件",
  ],
  code: [
    "## 実装内容",
    "## 変更ファイル一覧",
    "## テスト結果",
  ],
  review: [
    "## レビュー判定",
    "## 指摘事項",
    "## 改善提案",
  ],
};

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

export interface PhaseContext {
  include_outputs?: string[];
}

export interface PhaseConfig {
  name: string;
  type: PhaseType;
  description?: string;
  agent?: string;
  reviewer?: string;
  prompt?: string;
  context?: PhaseContext;
  output_format?: string[] | null;
  on: Partial<Record<TransitionCondition, string>>;
}

export interface Diagnostic {
  severity: "error" | "warning";
  workflow: string;
  phase?: string;
  message: string;
}

export interface WorkflowConfig {
  description?: string;
  max_iterations?: number;
  phases: PhaseConfig[];
  initialPhase(): PhaseConfig;
  resolveTransition(phaseName: string, condition: TransitionCondition): string;
  maxIterations(): number;
  getPhase(name: string): PhaseConfig | undefined;
  lint(workflowName: string): Diagnostic[];
}

export interface SquadConfig {
  workflows: Record<string, WorkflowConfig>;
  getWorkflow(name: string): WorkflowConfig | undefined;
  lint(): Diagnostic[];
}

class WorkflowConfigImpl implements WorkflowConfig {
  description?: string;
  max_iterations?: number;
  phases: PhaseConfig[];

  constructor(data: { description?: string; max_iterations?: number; phases: PhaseConfig[] }) {
    this.description = data.description;
    this.max_iterations = data.max_iterations;
    this.phases = data.phases;
  }

  initialPhase(): PhaseConfig {
    if (this.phases.length === 0) {
      throw new CcsquadError("config", "ワークフローにフェーズが定義されていません");
    }
    return this.phases[0];
  }

  resolveTransition(phaseName: string, condition: TransitionCondition): string {
    const phase = this.getPhase(phaseName);
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

  maxIterations(): number {
    return this.max_iterations ?? 10;
  }

  getPhase(name: string): PhaseConfig | undefined {
    return this.phases.find((p) => p.name === name);
  }

  lint(workflowName: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (this.phases.length === 0) {
      diagnostics.push({ severity: "error", workflow: workflowName, message: "フェーズが定義されていません" });
      return diagnostics;
    }

    const phaseNames = new Set(this.phases.map((p) => p.name));

    for (const phase of this.phases) {
      // Validate type
      if (!ALL_PHASE_TYPES.includes(phase.type)) {
        diagnostics.push({
          severity: "error",
          workflow: workflowName,
          phase: phase.name,
          message: `type '${phase.type}' が不正です (${ALL_PHASE_TYPES.join(", ")} を指定してください)`,
        });
        continue;
      }

      // Validate transition targets
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
        // Review phase: reviewer required, agent not allowed
        if (!phase.reviewer) {
          diagnostics.push({
            severity: "error",
            workflow: workflowName,
            phase: phase.name,
            message: "reviewer が設定されていません",
          });
        }
        if (phase.agent) {
          diagnostics.push({
            severity: "error",
            workflow: workflowName,
            phase: phase.name,
            message: "agent は設定できません",
          });
        }
        if (!phase.on["approved"]) {
          diagnostics.push({
            severity: "error",
            workflow: workflowName,
            phase: phase.name,
            message: "'approved' ルールがありません",
          });
        }
        if (!phase.on["rejected"]) {
          diagnostics.push({
            severity: "error",
            workflow: workflowName,
            phase: phase.name,
            message: "'rejected' ルールがありません",
          });
        }
      } else {
        // Task-like phase (task, research, plan, code): agent required, reviewer not allowed
        if (!phase.agent) {
          diagnostics.push({
            severity: "error",
            workflow: workflowName,
            phase: phase.name,
            message: "agent が設定されていません",
          });
        }
        if (phase.reviewer) {
          diagnostics.push({
            severity: "error",
            workflow: workflowName,
            phase: phase.name,
            message: "reviewer は設定できません",
          });
        }
        if (!phase.on["completed"]) {
          diagnostics.push({
            severity: "error",
            workflow: workflowName,
            phase: phase.name,
            message: "'completed' ルールがありません",
          });
        }
      }

      if (phase.context?.include_outputs) {
        for (const ref of phase.context.include_outputs) {
          if (!phaseNames.has(ref)) {
            diagnostics.push({
              severity: "error",
              workflow: workflowName,
              phase: phase.name,
              message: `context.include_outputs に存在しないフェーズ '${ref}' が指定されています`,
            });
          }
        }
      }
    }

    // Detect unreachable phases
    const initial = this.initialPhase();
    const reachable = new Set<string>();
    const stack = [initial.name];
    while (stack.length > 0) {
      const phaseName = stack.pop()!;
      if (reachable.has(phaseName)) continue;
      reachable.add(phaseName);
      const phase = this.getPhase(phaseName);
      if (phase) {
        for (const next of Object.values(phase.on)) {
          if (next !== "COMPLETE" && next !== "ABORT") {
            stack.push(next);
          }
        }
      }
    }

    for (const phase of this.phases) {
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
}

class SquadConfigImpl implements SquadConfig {
  workflows: Record<string, WorkflowConfig>;

  constructor(workflows: Record<string, WorkflowConfig>) {
    this.workflows = workflows;
  }

  static load(path: string): SquadConfig {
    const content = readFileSync(path, "utf-8");
    return SquadConfigImpl.parse(content);
  }

  static parse(content: string): SquadConfig {
    const raw = parse(content);
    if (!raw || typeof raw !== "object" || !raw.workflows) {
      throw new CcsquadError("config", "設定ファイルの形式が不正です");
    }

    const workflows: Record<string, WorkflowConfig> = {};
    for (const [name, wfRaw] of Object.entries(raw.workflows as Record<string, unknown>)) {
      const wf = wfRaw as Record<string, unknown>;
      const phasesRaw = wf.phases;

      let phases: PhaseConfig[];
      if (Array.isArray(phasesRaw)) {
        phases = phasesRaw.map((p: Record<string, unknown>) => ({
          name: p.name as string,
          type: p.type as PhaseType,
          description: p.description as string | undefined,
          agent: p.agent as string | undefined,
          reviewer: p.reviewer as string | undefined,
          prompt: p.prompt as string | undefined,
          context: p.context as PhaseContext | undefined,
          output_format: p.output_format != null ? (p.output_format as string[]) : undefined,
          on: (p.on as Partial<Record<TransitionCondition, string>>) ?? {},
        }));
      } else {
        phases = [];
      }

      workflows[name] = new WorkflowConfigImpl({
        description: wf.description as string | undefined,
        max_iterations: wf.max_iterations as number | undefined,
        phases,
      });
    }

    return new SquadConfigImpl(workflows);
  }

  getWorkflow(name: string): WorkflowConfig | undefined {
    return this.workflows[name];
  }

  lint(): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const [name, workflow] of Object.entries(this.workflows)) {
      diagnostics.push(...workflow.lint(name));
    }
    return diagnostics;
  }
}

export { SquadConfigImpl, WorkflowConfigImpl };
