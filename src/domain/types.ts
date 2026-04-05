// ── Common ──

export type Severity = "info" | "warning" | "critical";

// ── Transition & Phase ──

export type TransitionCondition = "completed" | "failed" | "rejected" | "approved";
export type PhaseType = "plan" | "execute" | "review";

export const ALL_CONDITIONS: TransitionCondition[] = ["completed", "failed", "rejected", "approved"];
export const ALL_PHASE_TYPES: PhaseType[] = ["plan", "execute", "review"];

export interface AgentSpec {
  agent: string;
  constraint?: string;
}

export interface PhaseConfig {
  name: string;
  type: PhaseType;
  agent?: string;
  agents?: AgentSpec[];
  auto?: boolean;
  on: Partial<Record<TransitionCondition, string>>;
}

export function resolveAgent(phase: PhaseConfig): string {
  return phase.agent!;
}

export function resolveAgents(phase: PhaseConfig): AgentSpec[] {
  if (phase.agents && phase.agents.length > 0) {
    return phase.agents;
  }
  return [{ agent: phase.agent! }];
}

export function isMultiAgent(phase: PhaseConfig): boolean {
  return phase.agents != null && phase.agents.length > 1;
}

export interface WorkflowConfig {
  phases: PhaseConfig[];
}

// ── Workflow serialization ──

export function workflowToObject(wf: WorkflowConfig): Record<string, Record<string, unknown>> {
  const obj: Record<string, Record<string, unknown>> = {};
  for (const phase of wf.phases) {
    const entry: Record<string, unknown> = { type: phase.type };
    if (phase.agents && phase.agents.length > 0) {
      entry.agents = phase.agents;
    } else if (phase.agent) {
      entry.agent = phase.agent;
    }
    if (phase.auto) entry.auto = true;
    entry.on = { ...phase.on };
    obj[phase.name] = entry;
  }
  return obj;
}

// ── Job ──

export type JobStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
export const ALL_JOB_STATUSES: readonly JobStatus[] = ["pending", "running", "paused", "completed", "failed", "aborted"];

export type PauseReason = "human_review" | "max_iterations";

export interface AcceptanceCriterion {
  description: string;
  done: boolean;
}

export interface JobFrontmatter {
  id: string;
  title: string;
  status: JobStatus;
  current_phase?: string;
  pause_reason?: PauseReason;
  iteration: number;
  max_iterations: number;
  priority: number;
  depends_on: string[];
  acceptance_criteria: AcceptanceCriterion[];
  workflow: WorkflowConfig;
  created_at: string;
  updated_at: string;
}

export interface Job {
  frontmatter: JobFrontmatter;
  body: string;
}

