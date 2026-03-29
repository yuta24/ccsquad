import { existsSync } from "node:fs";
import { join } from "node:path";
import { CcsquadError } from "../error.js";

export interface WorktreeInfo {
  jobId: string;
  worktreePath: string;
  branch: string;
}

export class WorktreeManager {
  constructor(
    private projectRoot: string,
    private worktreeBaseDir: string,
  ) {}

  private branchName(jobId: string): string {
    return `ccsquad/${jobId}`;
  }

  getPath(jobId: string): string {
    return join(this.worktreeBaseDir, jobId);
  }

  exists(jobId: string): boolean {
    return existsSync(this.getPath(jobId));
  }

  async create(jobId: string): Promise<WorktreeInfo> {
    const worktreePath = this.getPath(jobId);
    const branch = this.branchName(jobId);

    if (this.exists(jobId)) {
      throw new CcsquadError("dag", `worktree が既に存在します: ${worktreePath}`);
    }

    const proc = Bun.spawn(["git", "worktree", "add", "-b", branch, worktreePath], {
      cwd: this.projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      // Branch already exists — try without -b
      if (stderr.includes("already exists")) {
        const retry = Bun.spawn(["git", "worktree", "add", worktreePath, branch], {
          cwd: this.projectRoot,
          stdout: "pipe",
          stderr: "pipe",
        });
        const retryCode = await retry.exited;
        if (retryCode !== 0) {
          const retryErr = await new Response(retry.stderr).text();
          throw new CcsquadError("dag", `worktree 作成エラー: ${retryErr.trim()}`);
        }
      } else {
        throw new CcsquadError("dag", `worktree 作成エラー: ${stderr.trim()}`);
      }
    }

    return { jobId, worktreePath, branch };
  }

  async remove(jobId: string): Promise<void> {
    const worktreePath = this.getPath(jobId);
    if (!this.exists(jobId)) return;

    const proc = Bun.spawn(["git", "worktree", "remove", "--force", worktreePath], {
      cwd: this.projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new CcsquadError("dag", `worktree 削除エラー: ${stderr.trim()}`);
    }
  }

  async listAll(): Promise<WorktreeInfo[]> {
    const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
      cwd: this.projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    const infos: WorktreeInfo[] = [];
    let currentPath = "";
    let currentBranch = "";

    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        currentBranch = line.slice("branch ".length).replace("refs/heads/", "");
      } else if (line === "") {
        if (currentBranch.startsWith("ccsquad/")) {
          const jobId = currentBranch.replace("ccsquad/", "");
          infos.push({ jobId, worktreePath: currentPath, branch: currentBranch });
        }
        currentPath = "";
        currentBranch = "";
      }
    }

    return infos;
  }
}
