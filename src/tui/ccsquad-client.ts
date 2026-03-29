import type { DagStatusJob, JobShowResult } from "./types.js";

const CCSQUAD_BIN = process.argv[1] ?? "ccsquad";

async function runCommand(args: string[]): Promise<string> {
  const proc = Bun.spawn([CCSQUAD_BIN, ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`ccsquad ${args.join(" ")} failed (exit ${exitCode}): ${stderr}`);
  }
  return stdout;
}

export async function fetchDagStatus(): Promise<DagStatusJob[]> {
  const output = await runCommand(["dag", "status", "--format", "json"]);
  return parseDagStatusOutput(output);
}

export function parseDagStatusOutput(output: string): DagStatusJob[] {
  const trimmed = output.trim();
  if (trimmed === "" || trimmed === "[]") return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item: Record<string, unknown>) => ({
    id: String(item.id ?? ""),
    title: String(item.title ?? ""),
    status: String(item.status ?? "pending") as DagStatusJob["status"],
    current_phase: item.current_phase != null ? String(item.current_phase) : null,
    iteration: Number(item.iteration ?? 0),
    worktree_exists: Boolean(item.worktree_exists),
  }));
}

export async function fetchJobShow(jobId: string): Promise<JobShowResult> {
  const output = await runCommand(["job", "show", jobId, "--format", "json"]);
  return parseJobShowOutput(output);
}

export function parseJobShowOutput(output: string): JobShowResult {
  const parsed = JSON.parse(output.trim());
  return {
    id: String(parsed.id ?? ""),
    title: String(parsed.title ?? ""),
    status: String(parsed.status ?? "pending") as JobShowResult["status"],
    current_phase: parsed.current_phase != null ? String(parsed.current_phase) : undefined,
    iteration: Number(parsed.iteration ?? 0),
    max_iterations: Number(parsed.max_iterations ?? 10),
    priority: Number(parsed.priority ?? 0),
    depends_on: Array.isArray(parsed.depends_on) ? parsed.depends_on.map(String) : [],
    created_at: String(parsed.created_at ?? ""),
    updated_at: String(parsed.updated_at ?? ""),
    body: String(parsed.body ?? ""),
    phase_config: parsed.phase_config
      ? {
          type: String(parsed.phase_config.type),
          agent: String(parsed.phase_config.agent),
          auto: Boolean(parsed.phase_config.auto),
        }
      : undefined,
  };
}

export async function readLogFile(jobId: string): Promise<string> {
  const logPath = `${process.cwd()}/.ccsquad/logs/${jobId}.log`;
  try {
    const file = Bun.file(logPath);
    if (!(await file.exists())) return "";
    return await file.text();
  } catch {
    return "";
  }
}
