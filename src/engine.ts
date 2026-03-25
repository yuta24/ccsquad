import { CcsquadError } from "./error.js";
import type { WorkflowConfig, TransitionCondition } from "./config.js";
import type { Job } from "./job.js";
import { JobStore, appendPhaseLog } from "./job.js";

export class WorkflowEngine {
  constructor(
    private config: WorkflowConfig,
    private store: JobStore,
  ) {}

  private loadJob(jobId: string): Job {
    const job = this.store.load(jobId);
    // Normalize depends_on: it may be absent after YAML round-trip when empty
    job.frontmatter.depends_on = job.frontmatter.depends_on ?? [];
    return job;
  }

  startJob(jobId: string): Job {
    const job = this.loadJob(jobId);

    if (job.frontmatter.status !== "pending") {
      throw new CcsquadError(
        "job",
        `ジョブ '${jobId}' は既に開始されているか完了しています (status: ${job.frontmatter.status})`,
      );
    }

    for (const depId of job.frontmatter.depends_on) {
      const dep = this.loadJob(depId);
      if (dep.frontmatter.status !== "completed") {
        throw new CcsquadError(
          "job",
          `依存ジョブ '${depId}' が未完了です (status: ${dep.frontmatter.status})`,
        );
      }
    }

    const initial = this.config.initialPhase();
    job.frontmatter.status = "running";
    job.frontmatter.current_phase = initial.name;
    job.frontmatter.updated_at = new Date().toISOString();
    this.store.save(job);
    return job;
  }

  transition(jobId: string, result: TransitionCondition, message: string): Job {
    const job = this.loadJob(jobId);
    this.verifyRunning(job);

    const phaseName = this.currentPhaseName(job);
    const phaseConfig = this.getPhaseConfig(phaseName);

    if (phaseConfig.type === "review") {
      throw new CcsquadError(
        "workflow",
        "レビューフェーズでは approve/reject を使用してください",
      );
    }

    const next = this.config.resolveTransition(phaseName, result);
    this.executeTransition(job, phaseName, result, next, message);
    return job;
  }

  approve(jobId: string, message: string): Job {
    const job = this.loadJob(jobId);
    this.verifyRunning(job);

    const phaseName = this.currentPhaseName(job);
    const phaseConfig = this.getPhaseConfig(phaseName);

    if (phaseConfig.type !== "review") {
      throw new CcsquadError(
        "workflow",
        "このフェーズにはレビュアーが設定されていません",
      );
    }

    const next = this.config.resolveTransition(phaseName, "approved");
    this.executeTransition(job, phaseName, "approved", next, message);
    return job;
  }

  reject(jobId: string, message: string): Job {
    const job = this.loadJob(jobId);
    this.verifyRunning(job);

    const phaseName = this.currentPhaseName(job);
    const phaseConfig = this.getPhaseConfig(phaseName);

    if (phaseConfig.type !== "review") {
      throw new CcsquadError(
        "workflow",
        "このフェーズにはレビュアーが設定されていません",
      );
    }

    const next = this.config.resolveTransition(phaseName, "rejected");
    this.executeTransition(job, phaseName, "rejected", next, message);
    return job;
  }

  abortJob(jobId: string): Job {
    const job = this.loadJob(jobId);

    if (job.frontmatter.status !== "pending" && job.frontmatter.status !== "running") {
      throw new CcsquadError(
        "job",
        `ジョブ '${jobId}' は中断できません (status: ${job.frontmatter.status})`,
      );
    }

    if (job.frontmatter.status === "running" && job.frontmatter.current_phase !== undefined) {
      appendPhaseLog(job, job.frontmatter.current_phase, "aborted", "ABORT", "手動中断");
    }

    job.frontmatter.status = "aborted";
    job.frontmatter.current_phase = undefined;
    job.frontmatter.updated_at = new Date().toISOString();
    this.store.save(job);
    return job;
  }

  closeJob(jobId: string): Job {
    const job = this.loadJob(jobId);

    if (job.frontmatter.status === "closed") {
      throw new CcsquadError(
        "job",
        `ジョブ '${jobId}' は既にクローズされています (status: ${job.frontmatter.status})`,
      );
    }

    if (job.frontmatter.status === "running" && job.frontmatter.current_phase !== undefined) {
      appendPhaseLog(job, job.frontmatter.current_phase, "closed", "CLOSE", "手動クローズ");
    }

    job.frontmatter.status = "closed";
    job.frontmatter.current_phase = undefined;
    job.frontmatter.updated_at = new Date().toISOString();
    this.store.save(job);
    return job;
  }

  getStatus(jobId: string): { status: string; currentPhase?: string } {
    const job = this.loadJob(jobId);
    return {
      status: job.frontmatter.status,
      currentPhase: job.frontmatter.current_phase,
    };
  }

  private verifyRunning(job: Job): void {
    if (job.frontmatter.status !== "running") {
      throw new CcsquadError(
        "job",
        `ジョブ '${job.frontmatter.id}' は実行中ではありません (status: ${job.frontmatter.status})`,
      );
    }
  }

  private currentPhaseName(job: Job): string {
    if (job.frontmatter.current_phase === undefined) {
      throw new CcsquadError("workflow", "現在のフェーズが設定されていません");
    }
    return job.frontmatter.current_phase;
  }

  private getPhaseConfig(phaseName: string) {
    const phase = this.config.getPhase(phaseName);
    if (phase === undefined) {
      throw new CcsquadError(
        "workflow",
        `フェーズ '${phaseName}' がワークフローに定義されていません`,
      );
    }
    return phase;
  }

  private executeTransition(
    job: Job,
    phaseName: string,
    result: string,
    next: string,
    message: string,
  ): void {
    appendPhaseLog(job, phaseName, result, next, message);

    if (next === "COMPLETE") {
      job.frontmatter.status = "completed";
      job.frontmatter.current_phase = undefined;
    } else if (next === "ABORT") {
      job.frontmatter.status = "failed";
      job.frontmatter.current_phase = undefined;
    } else {
      job.frontmatter.current_phase = next;
    }

    job.frontmatter.updated_at = new Date().toISOString();
    this.store.save(job);
  }
}

export function checkCircularDependency(
  store: JobStore,
  jobId: string,
  dependsOn: string[],
): void {
  const visited = new Set<string>();
  const stack: string[] = [...dependsOn];

  while (stack.length > 0) {
    const depId = stack.pop()!;

    if (depId === jobId) {
      throw new CcsquadError("job", "循環依存が検出されました");
    }

    if (visited.has(depId)) {
      continue;
    }
    visited.add(depId);

    try {
      const depJob = store.load(depId);
      stack.push(...(depJob.frontmatter.depends_on ?? []));
    } catch {
      // Job not found, skip (like Rust implementation)
    }
  }
}
