import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { WorkflowConfig } from "../domain/types.js";
import { findConfigPathOrThrow, loadConfig } from "../infra/config-loader.js";
import { JobStore } from "../infra/job-store.js";
import { IterationStore } from "../infra/iteration-store.js";
import { EntryStore } from "../infra/entry-store.js";
import { OutputStore } from "../infra/output-store.js";

export interface ProjectContext {
  workflows: Record<string, WorkflowConfig>;
  jobStore: JobStore;
  iterationStore: IterationStore;
  entryStore: EntryStore;
  outputStore: OutputStore;
  projectRoot: string;
  squadDir: string;
  jobsDir: string;
  memoryDir: string;
  outputsDir: string;
}

export function createProjectContext(configPath?: string): ProjectContext {
  const resolvedPath = configPath ?? findConfigPathOrThrow();
  const workflows = loadConfig(resolvedPath);
  const projectRoot = dirname(resolvedPath);
  const squadDir = join(projectRoot, ".ccsquad");
  const jobsDir = join(squadDir, "jobs");
  const memoryDir = join(squadDir, "memory", "entries");
  const outputsDir = join(squadDir, "outputs");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(outputsDir, { recursive: true });

  return {
    workflows,
    jobStore: new JobStore(jobsDir),
    iterationStore: new IterationStore(squadDir),
    entryStore: new EntryStore(memoryDir),
    outputStore: new OutputStore(outputsDir),
    projectRoot,
    squadDir,
    jobsDir,
    memoryDir,
    outputsDir,
  };
}
