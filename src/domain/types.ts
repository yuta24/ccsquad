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

export function defaultAgentForType(type: PhaseType): string {
  return type === "review" ? "reviewer" : "developer";
}

export function resolveAgent(phase: PhaseConfig): string {
  return phase.agent ?? defaultAgentForType(phase.type);
}

export function resolveAgents(phase: PhaseConfig): AgentSpec[] {
  if (phase.agents && phase.agents.length > 0) {
    return phase.agents;
  }
  return [{ agent: resolveAgent(phase) }];
}

export function isMultiAgent(phase: PhaseConfig): boolean {
  return phase.agents != null && phase.agents.length > 1;
}

export interface WorkflowConfig {
  phases: PhaseConfig[];
}

// ── Job ──

export type JobStatus = "pending" | "running" | "completed" | "failed" | "aborted" | "cancelled";

export interface JobFrontmatter {
  id: string;
  title: string;
  status: JobStatus;
  current_phase?: string;
  iteration: number;
  max_iterations: number;
  priority: number;
  depends_on: string[];
  created_at: string;
  updated_at: string;
}

export interface Job {
  frontmatter: JobFrontmatter;
  body: string;
}

