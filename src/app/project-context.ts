import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { JobStore } from "../infra/job-store.js";
import { WorktreeManager } from "../infra/worktree-manager.js";
import { ProcessRunner } from "../infra/process-runner.js";

export interface ProjectContext {
  jobStore: JobStore;
  worktreeManager: WorktreeManager;
  processRunner: ProcessRunner;
  projectRoot: string;
  squadDir: string;
  jobsDir: string;
  worktreesDir: string;
  logsDir: string;
}

export function createProjectContext(): ProjectContext {
  const projectRoot = findProjectRoot();
  const squadDir = join(projectRoot, ".ccsquad");
  const jobsDir = join(squadDir, "jobs");
  const worktreesDir = join(squadDir, "worktrees");
  const logsDir = join(squadDir, "logs");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  return {
    jobStore: new JobStore(jobsDir),
    worktreeManager: new WorktreeManager(projectRoot, worktreesDir),
    processRunner: new ProcessRunner(logsDir),
    projectRoot,
    squadDir,
    jobsDir,
    worktreesDir,
    logsDir,
  };
}

function findProjectRoot(): string {
  if (process.env.CCSQUAD_ROOT) {
    return resolve(process.env.CCSQUAD_ROOT);
  }

  let dir = process.cwd();
  while (true) {
    if (existsSync(join(dir, ".ccsquad"))) return dir;
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  return process.cwd();
}
