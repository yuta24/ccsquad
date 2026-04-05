import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { JobStore } from "../infra/job-store.js";
import { PhaseLogStore } from "../infra/phase-log-store.js";
import { RetrospectiveStore } from "../infra/retrospective-store.js";
import { WorktreeManager } from "../infra/worktree-manager.js";
import { ProcessRunner } from "../infra/process-runner.js";

export interface ProjectContext {
  jobStore: JobStore;
  phaseLogStore: PhaseLogStore;
  retrospectiveStore: RetrospectiveStore;
  worktreeManager: WorktreeManager;
  processRunner: ProcessRunner;
  projectRoot: string;
  squadDir: string;
  jobsDir: string;
  worktreesDir: string;
  logsDir: string;
  retrospectivesDir: string;
}

export function createProjectContext(): ProjectContext {
  const projectRoot = findProjectRoot();
  const squadDir = join(projectRoot, ".ccsquad");
  const jobsDir = join(squadDir, "jobs");
  const worktreesDir = join(squadDir, "worktrees");
  const logsDir = join(squadDir, "logs");
  const retrospectivesDir = join(squadDir, "retrospectives");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(retrospectivesDir, { recursive: true });

  return {
    jobStore: new JobStore(jobsDir),
    phaseLogStore: new PhaseLogStore(logsDir),
    retrospectiveStore: new RetrospectiveStore(retrospectivesDir),
    worktreeManager: new WorktreeManager(projectRoot, worktreesDir),
    processRunner: new ProcessRunner(logsDir),
    projectRoot,
    squadDir,
    jobsDir,
    worktreesDir,
    logsDir,
    retrospectivesDir,
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
