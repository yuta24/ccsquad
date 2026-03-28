// ── Transition & Phase ──

export type TransitionCondition = "completed" | "failed" | "rejected" | "approved";
export type PhaseType = "plan" | "execute" | "review";

export const ALL_CONDITIONS: TransitionCondition[] = ["completed", "failed", "rejected", "approved"];
export const ALL_PHASE_TYPES: PhaseType[] = ["plan", "execute", "review"];

export interface PhaseConfig {
  name: string;
  type: PhaseType;
  on: Partial<Record<TransitionCondition, string>>;
}

export interface WorkflowConfig {
  phases: PhaseConfig[];
}

// ── Job ──

export type JobStatus = "pending" | "running" | "completed" | "failed" | "aborted";

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

