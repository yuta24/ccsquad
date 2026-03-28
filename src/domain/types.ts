// ── Transition & Phase ──

export type TransitionCondition = "completed" | "failed" | "rejected" | "approved";
export type PhaseType = "task" | "research" | "plan" | "code" | "review";

export const ALL_CONDITIONS: TransitionCondition[] = ["completed", "failed", "rejected", "approved"];
export const ALL_PHASE_TYPES: PhaseType[] = ["task", "research", "plan", "code", "review"];
export const TASK_LIKE_TYPES: PhaseType[] = ["task", "research", "plan", "code"];

export interface PhaseConfig {
  name: string;
  type: PhaseType;
  description?: string;
  agent?: string;
  reviewer?: string;
  prompt?: string;
  output_format?: string[] | null;
  on: Partial<Record<TransitionCondition, string>>;
}

export interface WorkflowConfig {
  description?: string;
  max_iterations?: number;
  phases: PhaseConfig[];
}

export interface Diagnostic {
  severity: "error" | "warning";
  workflow: string;
  phase?: string;
  message: string;
}

// ── Job ──

export type JobStatus = "pending" | "running" | "completed" | "failed" | "aborted" | "closed";

export interface JobFrontmatter {
  id: string;
  title: string;
  workflow: string;
  status: JobStatus;
  current_phase?: string;
  priority: number;
  depends_on: string[];
  created_at: string;
  updated_at: string;
}

export interface Job {
  frontmatter: JobFrontmatter;
  body: string;
}

// ── Output ──

export interface NodeOutput {
  seq: number;
  phase: string;
  executor: string;
  result: string;
  sessionId?: string;
  iteration: number;
  timestamp: string;
  content: string;
}

// ── Memory ──

export interface MemoryFrontmatter {
  type?: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryEntry {
  title: string;
  frontmatter: MemoryFrontmatter;
  body: string;
}
