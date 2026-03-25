import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { SquadConfigImpl } from "../config.js";
import type { SquadConfig } from "../config.js";
import { JobStore } from "../job.js";
import { IterationStore } from "../iteration.js";
import { EntryStore } from "../entry.js";
import { CcsquadError } from "../error.js";

export interface ProjectContext {
  config: SquadConfig;
  store: JobStore;
  iterationStore: IterationStore;
  entryStore: EntryStore;
  squadDir: string;
  jobsDir: string;
  memoryDir: string;
}

export function findConfig(): string | null {
  // CCSQUAD_ROOT が設定されていればそちらを優先
  const root = process.env.CCSQUAD_ROOT;
  if (root) {
    const candidate = join(root, "ccsquad.yaml");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  // 従来の cwd 探索
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, "ccsquad.yaml");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export function findConfigOrThrow(): string {
  const path = findConfig();
  if (!path) {
    throw new CcsquadError("config", "ccsquad.yaml が見つかりません");
  }
  return path;
}

export function createContext(configPath?: string): ProjectContext {
  const resolvedPath = configPath ?? findConfigOrThrow();
  const config = SquadConfigImpl.load(resolvedPath);
  const projectRoot = dirname(resolvedPath);
  const squadDir = join(projectRoot, ".ccsquad");
  const jobsDir = join(squadDir, "jobs");
  const memoryDir = join(squadDir, "memory", "entries");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });

  return {
    config,
    store: new JobStore(jobsDir),
    iterationStore: new IterationStore(squadDir),
    entryStore: new EntryStore(memoryDir),
    squadDir,
    jobsDir,
    memoryDir,
  };
}
