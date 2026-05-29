import type { ProjectContext } from "./project-context.js";
import { JobService } from "./job-service.js";
import { buildJobPrompt } from "./prompt-builder.js";
import type { Job, JobStatus } from "../domain/types.js";
import { resolveDag, isReadyToRun, collectDownstream } from "../domain/dag.js";
import type { DagNode, DagResolution } from "../domain/dag.js";
import type { ProcessHandle } from "../infra/process-runner.js";
import type { WorktreeInfo } from "../infra/worktree-manager.js";

// ── Types ──

export interface DagRunOptions {
  maxConcurrency: number;
  cascadeAbort: boolean;
  dryRun: boolean;
}

export type DagJobResult =
  | { status: "completed" }
  | { status: "failed" }
  | { status: "paused"; reason: string }
  | { status: "skipped" };

export interface DagRunResult {
  jobs: Map<string, DagJobResult>;
  resolution: DagResolution;
  targetJobs: Job[];
}

// ── Orchestrator ──

export class DagOrchestrator {
  private jobService: JobService;

  constructor(private ctx: ProjectContext) {
    this.jobService = new JobService(ctx);
  }

  async run(jobIds: string[], opts: DagRunOptions): Promise<DagRunResult> {
    const allJobs = this.ctx.jobStore.listAll();
    const targetJobs = jobIds.length > 0
      ? allJobs.filter((j) => jobIds.includes(j.frontmatter.id))
      : allJobs.filter((j) => j.frontmatter.status === "pending");

    if (targetJobs.length === 0) {
      return { jobs: new Map(), resolution: { groups: [], order: [] }, targetJobs: [] };
    }

    // Build DAG nodes
    const nodes: DagNode[] = targetJobs.map((j) => ({
      id: j.frontmatter.id,
      dependsOn: (j.frontmatter.depends_on ?? []).filter((dep) =>
        targetJobs.some((t) => t.frontmatter.id === dep),
      ),
    }));

    const resolution = resolveDag(nodes);

    if (opts.dryRun) {
      return { jobs: new Map(), resolution, targetJobs };
    }

    return this.executeLoop(nodes, resolution, targetJobs, opts);
  }

  private async executeLoop(
    nodes: DagNode[],
    resolution: DagResolution,
    targetJobs: Job[],
    opts: DagRunOptions,
  ): Promise<DagRunResult> {
    const results = new Map<string, DagJobResult>();
    const active = new Map<string, { handle: ProcessHandle; worktree: WorktreeInfo }>();
    const skipped = new Set<string>();
    let cancelled = false;

    // SIGINT handler: set flag and let the loop exit naturally via finally
    const sigintHandler = () => {
      console.log("\n中断中... プロセスとワークツリーをクリーンアップしています");
      cancelled = true;
      // Kill all processes immediately so Promise.race resolves
      this.ctx.processRunner.killAll();
    };
    process.on("SIGINT", sigintHandler);

    try {
      while (!cancelled) {
        // Find jobs ready to run
        const statusMap = this.buildStatusMap(targetJobs, results);
        const ready: string[] = [];

        for (const node of nodes) {
          if (results.has(node.id) || active.has(node.id) || skipped.has(node.id)) continue;
          if (isReadyToRun(node.id, nodes, statusMap)) {
            ready.push(node.id);
          }
        }

        // Start new jobs up to concurrency limit
        for (const jobId of ready) {
          if (active.size >= opts.maxConcurrency) break;

          try {
            const entry = await this.startJob(jobId);
            active.set(jobId, entry);
            console.log(`開始: ${jobId} (worktree: ${entry.worktree.branch})`);
          } catch (e) {
            console.error(`起動失敗: ${jobId} - ${e}`);
            results.set(jobId, { status: "failed" });
            if (opts.cascadeAbort) {
              this.skipDownstream(jobId, nodes, results, skipped);
            }
          }
        }

        // No active processes and no more ready jobs → done
        if (active.size === 0) break;

        // Wait for any process to complete
        const raceEntries = [...active.entries()].map(([jobId, entry]) =>
          entry.handle.exitPromise.then((exitCode) => ({ jobId, exitCode })),
        );

        const completed = await Promise.race(raceEntries);
        const entry = active.get(completed.jobId)!;
        active.delete(completed.jobId);

        if (cancelled) break;

        // Determine result from job file status
        const jobResult = await this.finalizeJob(completed.jobId, entry.worktree, completed.exitCode);

        results.set(completed.jobId, jobResult);
        console.log(`完了: ${completed.jobId} (${jobResult.status})`);

        // Cascade abort if needed
        if (opts.cascadeAbort && jobResult.status === "failed") {
          this.skipDownstream(completed.jobId, nodes, results, skipped);
        }
      }
    } finally {
      process.removeListener("SIGINT", sigintHandler);
      // Cleanup any remaining active processes and worktrees
      for (const [jobId, entry] of active) {
        this.ctx.processRunner.kill(jobId);
        await this.ctx.worktreeManager.remove(entry.worktree.jobId).catch(() => {});
      }
    }

    return { jobs: results, resolution, targetJobs };
  }

  private async startJob(jobId: string): Promise<{ handle: ProcessHandle; worktree: WorktreeInfo }> {
    // Start the job (pending → running), capturing the updated job returned by start()
    let job = this.ctx.jobStore.load(jobId);
    if (job.frontmatter.status === "pending") {
      job = this.jobService.start(jobId);
    }

    // Create worktree — if this fails, abort the job to avoid leaving it in running state
    let worktree: WorktreeInfo;
    try {
      worktree = await this.ctx.worktreeManager.create(jobId);
    } catch (e) {
      this.jobService.abort(jobId);
      throw e;
    }

    // Build prompt for claude using the post-start job state (current_phase is now set)
    const prompt = this.buildPrompt(job);

    // Spawn claude process — if this fails, clean up worktree and abort job
    try {
      const handle = this.ctx.processRunner.start(jobId, worktree.worktreePath, prompt);
      return { handle, worktree };
    } catch (e) {
      await this.ctx.worktreeManager.remove(jobId).catch(() => {});
      this.jobService.abort(jobId);
      throw e;
    }
  }

  private async finalizeJob(
    jobId: string,
    worktree: WorktreeInfo,
    exitCode: number,
  ): Promise<DagJobResult> {
    // Read the final job status
    const job = this.ctx.jobStore.load(jobId);
    const status = job.frontmatter.status;

    // Clean up process handle
    this.ctx.processRunner.remove(jobId);

    // Remove worktree (keep branch)
    await this.ctx.worktreeManager.remove(worktree.jobId).catch((e) => {
      console.error(`worktree 削除警告: ${jobId} - ${e}`);
    });

    switch (status) {
      case "completed":
        return { status: "completed" };
      case "failed":
      case "aborted":
        return { status: "failed" };
      case "paused":
        return { status: "paused", reason: job.frontmatter.pause_reason ?? "human_review" };
      case "running":
        // Still running means process exited without completing the workflow
        if (exitCode !== 0) return { status: "failed" };
        if (job.frontmatter.current_phase) {
          return { status: "paused", reason: "human_review" };
        }
        return { status: "failed" };
      default:
        return { status: "failed" };
    }
  }

  private buildPrompt(job: Job): string {
    return buildJobPrompt(job);
  }

  private buildStatusMap(
    targetJobs: Job[],
    results: Map<string, DagJobResult>,
  ): Map<string, JobStatus> {
    const statusMap = new Map<string, JobStatus>();

    for (const job of targetJobs) {
      const id = job.frontmatter.id;
      const result = results.get(id);
      if (result) {
        switch (result.status) {
          case "completed":
            statusMap.set(id, "completed");
            break;
          case "failed":
          case "skipped":
            statusMap.set(id, "failed");
            break;
          case "paused":
            // Paused jobs are not completed — downstream stays blocked
            statusMap.set(id, "running");
            break;
        }
      } else {
        statusMap.set(id, job.frontmatter.status);
      }
    }

    // Also include completed jobs outside the target set (for dependency resolution)
    const allJobs = this.ctx.jobStore.listAll();
    for (const job of allJobs) {
      if (!statusMap.has(job.frontmatter.id)) {
        statusMap.set(job.frontmatter.id, job.frontmatter.status);
      }
    }

    return statusMap;
  }

  private skipDownstream(
    failedJobId: string,
    nodes: DagNode[],
    results: Map<string, DagJobResult>,
    skipped: Set<string>,
  ): void {
    const downstream = collectDownstream(failedJobId, nodes);
    for (const id of downstream) {
      if (!results.has(id) && !skipped.has(id)) {
        skipped.add(id);
        results.set(id, { status: "skipped" });
        console.log(`スキップ: ${id} (上流 ${failedJobId} が失敗)`);
      }
    }
  }
}
