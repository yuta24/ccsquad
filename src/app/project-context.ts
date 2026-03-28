import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { JobStore } from "../infra/job-store.js";

export interface ProjectContext {
  jobStore: JobStore;
  projectRoot: string;
  squadDir: string;
  jobsDir: string;
}

export function createProjectContext(): ProjectContext {
  const projectRoot = findProjectRoot();
  const squadDir = join(projectRoot, ".ccsquad");
  const jobsDir = join(squadDir, "jobs");
  mkdirSync(jobsDir, { recursive: true });

  return {
    jobStore: new JobStore(jobsDir),
    projectRoot,
    squadDir,
    jobsDir,
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
