import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CcsquadError } from "../error.js";

export interface ProcessHandle {
  jobId: string;
  pid: number;
  logFile: string;
  proc: Bun.Subprocess;
  exitPromise: Promise<number>;
}

export class ProcessRunner {
  private handles = new Map<string, ProcessHandle>();

  constructor(
    private logsDir: string,
    private projectRoot: string,
  ) {
    mkdirSync(logsDir, { recursive: true });
  }

  start(jobId: string, worktreePath: string, prompt: string): ProcessHandle {
    if (this.handles.has(jobId)) {
      throw new CcsquadError("dag", `ジョブ '${jobId}' のプロセスは既に起動中です`);
    }

    const logFile = join(this.logsDir, `${jobId}.log`);

    const proc = Bun.spawn(["claude", "-p", prompt, "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep,Agent,Skill"], {
      cwd: worktreePath,
      stdout: Bun.file(logFile),
      stderr: Bun.file(logFile),
      env: {
        ...process.env,
        CCSQUAD_ROOT: this.projectRoot,
      },
    });

    const handle: ProcessHandle = {
      jobId,
      pid: proc.pid,
      logFile,
      proc,
      exitPromise: proc.exited,
    };

    this.handles.set(jobId, handle);
    return handle;
  }

  get(jobId: string): ProcessHandle | undefined {
    return this.handles.get(jobId);
  }

  remove(jobId: string): void {
    this.handles.delete(jobId);
  }

  kill(jobId: string): void {
    const handle = this.handles.get(jobId);
    if (!handle) return;

    try {
      handle.proc.kill();
    } catch {
      // Process may already be dead
    }
    this.handles.delete(jobId);
  }

  killAll(): void {
    for (const [jobId] of this.handles) {
      this.kill(jobId);
    }
  }

  activeCount(): number {
    return this.handles.size;
  }
}
