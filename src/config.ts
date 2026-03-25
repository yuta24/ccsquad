import { readFileSync } from "fs";
import { parse } from "yaml";
import { CcsquadError } from "./error.js";

export type TransitionCondition = "completed" | "failed" | "rejected" | "approved";

const ALL_CONDITIONS: TransitionCondition[] = ["completed", "failed", "rejected", "approved"];

export function parseTransitionCondition(s: string): TransitionCondition {
  if (ALL_CONDITIONS.includes(s as TransitionCondition)) {
    return s as TransitionCondition;
  }
  throw new CcsquadError("workflow", `不明な遷移条件です: ${s}`);
}

export interface PhaseConfig {
  name: string;
  description?: string;
  agent?: string;
  reviewer?: string;
  pause: boolean;
  on: Partial<Record<TransitionCondition, string>>;
}

export interface WorkflowConfig {
  description?: string;
  max_iterations?: number;
  phases: PhaseConfig[];
  initialPhase(): PhaseConfig;
  resolveTransition(phaseName: string, condition: TransitionCondition): string;
  maxIterations(): number;
  getPhase(name: string): PhaseConfig | undefined;
  validate(workflowName: string): string[];
}

export interface SquadConfig {
  workflows: Record<string, WorkflowConfig>;
  getWorkflow(name: string): WorkflowConfig | undefined;
  validate(): string[];
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

  validate(workflowName: string): string[] {
    const warnings: string[] = [];

    if (this.phases.length === 0) {
      throw new CcsquadError("config", `ワークフロー '${workflowName}': フェーズが定義されていません`);
    }

    const phaseNames = new Set(this.phases.map((p) => p.name));

    for (const phase of this.phases) {
      // Validate transition targets
      for (const next of Object.values(phase.on)) {
        if (next !== "COMPLETE" && next !== "ABORT" && !phaseNames.has(next)) {
          throw new CcsquadError(
            "config",
            `ワークフロー '${workflowName}': フェーズ '${phase.name}' の遷移先 '${next}' が存在しません`,
          );
        }
      }

      if (phase.reviewer !== undefined) {
        // Reviewer phase: approved and rejected are required
        if (!phase.on["approved"]) {
          throw new CcsquadError(
            "config",
            `ワークフロー '${workflowName}': レビューフェーズ '${phase.name}' に 'approved' ルールがありません`,
          );
        }
        if (!phase.on["rejected"]) {
          throw new CcsquadError(
            "config",
            `ワークフロー '${workflowName}': レビューフェーズ '${phase.name}' に 'rejected' ルールがありません`,
          );
        }
      } else {
        // Normal phase: completed is required
        if (!phase.on["completed"]) {
          throw new CcsquadError(
            "config",
            `ワークフロー '${workflowName}': フェーズ '${phase.name}' に 'completed' ルールがありません`,
          );
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
        warnings.push(`ワークフロー '${workflowName}': フェーズ '${phase.name}' は到達不能です`);
      }
    }

    return warnings;
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
          description: p.description as string | undefined,
          agent: p.agent as string | undefined,
          reviewer: p.reviewer as string | undefined,
          pause: (p.pause as boolean | undefined) ?? false,
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

  validate(): string[] {
    const warnings: string[] = [];
    for (const [name, workflow] of Object.entries(this.workflows)) {
      const w = workflow.validate(name);
      warnings.push(...w);
    }
    return warnings;
  }
}

export { SquadConfigImpl, WorkflowConfigImpl };
