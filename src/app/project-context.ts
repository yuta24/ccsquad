import { mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
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
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      // If .git is a file, this is a worktree — resolve to the main repo root
      const mainRoot = resolveMainRepoFromWorktree(gitPath);
      if (mainRoot && existsSync(join(mainRoot, ".ccsquad"))) {
        return mainRoot;
      }
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  return process.cwd();
}

/**
 * If gitPath is a worktree's .git file (not a directory), parse it to find the main repo root.
 * Worktree .git files contain: "gitdir: /path/to/main-repo/.git/worktrees/{name}"
 */
function resolveMainRepoFromWorktree(gitPath: string): string | null {
  try {
    if (!statSync(gitPath).isFile()) return null;
    const content = readFileSync(gitPath, "utf-8").trim();
    const match = content.match(/^gitdir:\s+(.+)$/);
    if (!match) return null;
    const gitdir = resolve(dirname(gitPath), match[1]);
    let d = gitdir;
    while (true) {
      const base = basename(d);
      const parent = dirname(d);
      if (base === ".git") return parent;
      if (parent === d) return null;
      d = parent;
    }
  } catch {
    return null;
  }
}
