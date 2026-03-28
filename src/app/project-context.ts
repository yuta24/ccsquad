import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { JobStore } from "../infra/job-store.js";
import { OutputStore } from "../infra/output-store.js";

export interface ProjectContext {
  jobStore: JobStore;
  outputStore: OutputStore;
  projectRoot: string;
  squadDir: string;
  jobsDir: string;
  outputsDir: string;
}

export function createProjectContext(): ProjectContext {
  const projectRoot = findProjectRoot();
  const squadDir = join(projectRoot, ".ccsquad");
  const jobsDir = join(squadDir, "jobs");
  const outputsDir = join(squadDir, "outputs");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(outputsDir, { recursive: true });

  return {
    jobStore: new JobStore(jobsDir),
    outputStore: new OutputStore(outputsDir),
    projectRoot,
    squadDir,
    jobsDir,
    outputsDir,
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
