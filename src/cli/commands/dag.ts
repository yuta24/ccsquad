import type { ProjectContext } from "../../app/project-context.js";
import { DagOrchestrator } from "../../app/dag-orchestrator.js";
import type { DagRunOptions, DagJobResult } from "../../app/dag-orchestrator.js";

export async function cmdDagRun(
  ctx: ProjectContext,
  jobIds: string[],
  opts: { maxConcurrency: number; noCascade: boolean; dryRun: boolean },
): Promise<void> {
  const orchestrator = new DagOrchestrator(ctx);

  const runOpts: DagRunOptions = {
    maxConcurrency: opts.maxConcurrency,
    cascadeAbort: !opts.noCascade,
    dryRun: opts.dryRun,
  };

  const dagResult = await orchestrator.run(jobIds, runOpts);

  if (dagResult.targetJobs.length === 0) {
    console.log("実行対象のジョブがありません。");
    return;
  }

  if (opts.dryRun) {
    const { resolution, targetJobs } = dagResult;
    const allJobs = ctx.jobStore.listAll();

    console.log("実行計画 (dry-run):\n");
    for (let i = 0; i < resolution.groups.length; i++) {
      const group = resolution.groups[i];
      const label = group.length > 1 ? "並列" : "逐次";
      console.log(`  Wave ${i + 1} (${label}):`);
      for (const jobId of group) {
        const job = allJobs.find((j) => j.frontmatter.id === jobId)!;
        const deps = job.frontmatter.depends_on ?? [];
        const depStr = deps.length > 0 ? ` (依存: ${deps.join(", ")})` : "";
        console.log(`    ${jobId}: ${job.frontmatter.title}${depStr}`);
      }
    }
    console.log(`\n合計: ${targetJobs.length} ジョブ, 最大並列数: ${opts.maxConcurrency}`);
    return;
  }

  // Print summary
  console.log("\n--- DAG 実行結果 ---");
  let completed = 0;
  let failed = 0;
  let paused = 0;
  let skipped = 0;

  for (const [jobId, jobResult] of dagResult.jobs) {
    const icon = statusIcon(jobResult);
    console.log(`  ${icon} ${jobId}: ${jobResult.status}`);
    switch (jobResult.status) {
      case "completed": completed++; break;
      case "failed": failed++; break;
      case "paused": paused++; break;
      case "skipped": skipped++; break;
    }
  }

  console.log(`\n完了: ${completed}, 失敗: ${failed}, 一時停止: ${paused}, スキップ: ${skipped}`);
}

export async function cmdDagStatus(ctx: ProjectContext, format: "text" | "json"): Promise<void> {
  const allJobs = ctx.jobStore.listAll();
  const runningJobs = allJobs.filter((j) => j.frontmatter.status === "running");

  if (format === "json") {
    const output = runningJobs.map((j) => ({
      id: j.frontmatter.id,
      title: j.frontmatter.title,
      status: j.frontmatter.status,
      current_phase: j.frontmatter.current_phase,
      iteration: j.frontmatter.iteration,
      worktree_exists: ctx.worktreeManager.exists(j.frontmatter.id),
    }));
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (runningJobs.length === 0) {
      console.log("実行中のジョブはありません。");
      return;
    }
    console.log("実行中のジョブ:\n");
    for (const job of runningJobs) {
      const fm = job.frontmatter;
      const wt = ctx.worktreeManager.exists(fm.id) ? "worktree あり" : "worktree なし";
      console.log(`  ${fm.id}: ${fm.title}`);
      console.log(`    フェーズ: ${fm.current_phase ?? "-"}, イテレーション: ${fm.iteration}/${fm.max_iterations}, ${wt}`);
    }
  }
}

export async function cmdDagClean(ctx: ProjectContext): Promise<void> {
  const worktrees = await ctx.worktreeManager.listAll();

  if (worktrees.length === 0) {
    console.log("クリーンアップ対象の worktree はありません。");
    return;
  }

  let cleaned = 0;
  for (const wt of worktrees) {
    try {
      const job = ctx.jobStore.load(wt.jobId);
      const status = job.frontmatter.status;
      // Remove worktrees for jobs that are no longer running
      if (status !== "running") {
        await ctx.worktreeManager.remove(wt.jobId);
        console.log(`削除: ${wt.worktreePath} (ジョブ ${wt.jobId}: ${status})`);
        cleaned++;
      }
    } catch {
      // Job file not found — orphan worktree
      await ctx.worktreeManager.remove(wt.jobId);
      console.log(`削除: ${wt.worktreePath} (孤立 worktree)`);
      cleaned++;
    }
  }

  console.log(`${cleaned} 件の worktree を削除しました。`);
}

function statusIcon(result: DagJobResult): string {
  switch (result.status) {
    case "completed": return "OK";
    case "failed": return "NG";
    case "paused": return "||";
    case "skipped": return "--";
  }
}
