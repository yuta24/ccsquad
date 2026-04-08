import type { ProjectContext } from "../app/project-context.js";
import { JobService } from "../app/job-service.js";
import { buildJobPrompt } from "../app/prompt-builder.js";
import { CcsquadError } from "../error.js";

export interface LaunchResult {
  pid: number;
  logFile: string;
  worktreePath: string;
}

export async function launchJob(ctx: ProjectContext, jobId: string): Promise<LaunchResult> {
  const jobService = new JobService(ctx);

  // pending → running (依存チェック含む)
  jobService.start(jobId);

  // worktree 作成 — 失敗時は abort してロールバック
  let worktreePath: string;
  try {
    const worktree = await ctx.worktreeManager.create(jobId);
    worktreePath = worktree.worktreePath;
  } catch (e) {
    jobService.abort(jobId);
    throw e;
  }

  // claude CLI 起動 — 失敗時は worktree 削除 + abort
  const prompt = buildJobPrompt(jobId);
  try {
    const handle = ctx.processRunner.start(jobId, worktreePath, prompt);
    return { pid: handle.pid, logFile: handle.logFile, worktreePath };
  } catch (e) {
    await ctx.worktreeManager.remove(jobId).catch(() => {});
    jobService.abort(jobId);
    throw e;
  }
}

export async function resumeJob(ctx: ProjectContext, jobId: string): Promise<LaunchResult> {
  const job = ctx.jobStore.load(jobId);

  if (job.frontmatter.status !== "running" && job.frontmatter.status !== "paused") {
    throw new CcsquadError(
      "job",
      `ジョブ ${jobId} は running/paused 状態ではありません (status: ${job.frontmatter.status})`,
    );
  }

  // 古いハンドルをクリア（前回のプロセスは既に終了している前提）
  ctx.processRunner.remove(jobId);

  // worktree — 存在しない場合は作成
  let worktreePath: string;
  if (ctx.worktreeManager.exists(jobId)) {
    worktreePath = ctx.worktreeManager.getPath(jobId);
  } else {
    const worktree = await ctx.worktreeManager.create(jobId);
    worktreePath = worktree.worktreePath;
  }

  // claude CLI 起動
  const prompt = buildJobPrompt(jobId);
  try {
    const handle = ctx.processRunner.start(jobId, worktreePath, prompt);
    return { pid: handle.pid, logFile: handle.logFile, worktreePath };
  } catch (e) {
    // resumeJob で新規作成した worktree のみクリーンアップ
    // 既存 worktree は手動管理のため削除しない
    throw e;
  }
}
