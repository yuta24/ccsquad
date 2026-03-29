export type JobStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface DagStatusJob {
  id: string;
  title: string;
  status: JobStatus;
  current_phase: string | null;
  iteration: number;
  worktree_exists: boolean;
}

export interface JobShowResult {
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
  body: string;
  phase_config?:
    | { type: string; agent: string; auto: boolean }
    | { type: string; agents: Array<{ agent: string; constraint?: string }>; auto: boolean };
}
