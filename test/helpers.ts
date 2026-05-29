import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/infra/job-store.js";
import { WorktreeManager } from "../src/infra/worktree-manager.js";
import { ProcessRunner } from "../src/infra/process-runner.js";
import type { ProjectContext } from "../src/app/project-context.js";

export function createTestContext(prefix = "ccsquad-test-"): ProjectContext {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const jobsDir = join(dir, "jobs");
  const worktreesDir = join(dir, "worktrees");
  const logsDir = join(dir, "logs");
  const store = new JobStore(jobsDir);
  store.ensureDir();

  return {
    jobStore: store,
    worktreeManager: new WorktreeManager(dir, worktreesDir),
    processRunner: new ProcessRunner(logsDir),
    projectRoot: dir,
    squadDir: dir,
    jobsDir,
    worktreesDir,
    logsDir,
  };
}
