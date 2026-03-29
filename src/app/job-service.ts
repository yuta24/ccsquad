import { CcsquadError } from "../error.js";
import type { Job, TransitionCondition, PhaseConfig, WorkflowConfig } from "../domain/types.js";
import { initialPhase, parseWorkflowFromBody, generateWorkflowSection } from "../domain/workflow.js";
import { computeTransition } from "../domain/state-machine.js";
import type { TransitionDecision } from "../domain/state-machine.js";
import { buildPhaseLogEntry, appendPhaseLog } from "../domain/phase-log.js";
import type { ProjectContext } from "./project-context.js";

export type TransitionResult =
  | { type: "done"; jobId: string; status: string }
  | { type: "continue"; jobId: string; nextPhase: string; phaseConfig: PhaseConfig }
  | { type: "pause"; jobId: string; nextPhase: string; phaseConfig: PhaseConfig; reason: "human_review" | "max_iterations" };

export class JobService {
  constructor(private ctx: ProjectContext) {}

  private loadJob(jobId: string): Job {
    const job = this.ctx.jobStore.load(jobId);
    job.frontmatter.depends_on = job.frontmatter.depends_on ?? [];
    return job;
  }

  private getWorkflowForJob(job: Job): WorkflowConfig {
    return parseWorkflowFromBody(job.body);
  }

  create(
    title: string,
    workflowConfig: WorkflowConfig,
    opts?: { description?: string; priority?: number; dependsOn?: string[]; maxIterations?: number },
  ): Job {
    const id = this.ctx.jobStore.nextId();
    const now = new Date().toISOString();

    const workflowBody = generateWorkflowSection(workflowConfig);
    const descBody = opts?.description ? `## 説明\n${opts.description}\n\n` : "";

    const job: Job = {
      frontmatter: {
        id,
        title,
        status: "pending",
        iteration: 0,
        max_iterations: opts?.maxIterations ?? 10,
        priority: opts?.priority ?? 0,
        depends_on: opts?.dependsOn ?? [],
        created_at: now,
        updated_at: now,
      },
      body: descBody + workflowBody,
    };
    this.ctx.jobStore.save(job);
    return job;
  }

  start(jobId: string): Job {
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

    const wf = this.getWorkflowForJob(job);
    const initial = initialPhase(wf);
    job.frontmatter.status = "running";
    job.frontmatter.current_phase = initial.name;
    job.frontmatter.iteration = 0;
    job.frontmatter.updated_at = new Date().toISOString();
    this.ctx.jobStore.save(job);
    return job;
  }

  transition(jobId: string, condition: TransitionCondition, message: string): TransitionResult {
    const job = this.loadJob(jobId);
    const wf = this.getWorkflowForJob(job);

    const decision = computeTransition({ job, workflow: wf, condition });
    const phaseName = job.frontmatter.current_phase!;

    return this.applyDecision(job, phaseName, condition, message, decision);
  }

  abort(jobId: string): Job {
    const job = this.loadJob(jobId);

    if (job.frontmatter.status !== "pending" && job.frontmatter.status !== "running") {
      throw new CcsquadError(
        "job",
        `ジョブ '${jobId}' は中断できません (status: ${job.frontmatter.status})`,
      );
    }

    if (job.frontmatter.status === "running" && job.frontmatter.current_phase !== undefined) {
      const entry = buildPhaseLogEntry(job.frontmatter.current_phase, "aborted", "ABORT", "手動中断");
      job.body = appendPhaseLog(job.body, entry);
    }

    job.frontmatter.status = "aborted";
    job.frontmatter.current_phase = undefined;
    job.frontmatter.iteration = 0;
    job.frontmatter.updated_at = new Date().toISOString();
    this.ctx.jobStore.save(job);
    return job;
  }

  findDependents(jobId: string): string[] {
    const allJobs = this.ctx.jobStore.listAll();
    return allJobs
      .filter((j) => (j.frontmatter.depends_on ?? []).includes(jobId))
      .map((j) => j.frontmatter.id);
  }

  list(): Job[] {
    return this.ctx.jobStore.listAll();
  }

  get(jobId: string): Job {
    return this.loadJob(jobId);
  }

  getStatus(jobId: string): { status: string; currentPhase?: string } {
    const job = this.loadJob(jobId);
    return {
      status: job.frontmatter.status,
      currentPhase: job.frontmatter.current_phase,
    };
  }

  private applyDecision(
    job: Job,
    phaseName: string,
    condition: TransitionCondition,
    message: string,
    decision: TransitionDecision,
  ): TransitionResult {
    const jobId = job.frontmatter.id;

    switch (decision.action) {
      case "complete":
      case "abort": {
        const targetStatus = decision.action === "complete" ? "completed" : "failed";
        const target = decision.action === "complete" ? "COMPLETE" : "ABORT";
        const entry = buildPhaseLogEntry(phaseName, condition, target, message);
        job.body = appendPhaseLog(job.body, entry);
        job.frontmatter.status = targetStatus;
        job.frontmatter.current_phase = undefined;
        job.frontmatter.updated_at = new Date().toISOString();
        this.ctx.jobStore.save(job);
        return { type: "done", jobId, status: targetStatus };
      }

      case "pause": {
        if (decision.reason === "max_iterations") {
          const entry = buildPhaseLogEntry(phaseName, condition, decision.nextPhase, message);
          job.body = appendPhaseLog(job.body, entry);
          job.frontmatter.updated_at = new Date().toISOString();
          this.ctx.jobStore.save(job);
        } else {
          const entry = buildPhaseLogEntry(phaseName, condition, decision.nextPhase, message);
          job.body = appendPhaseLog(job.body, entry);
          job.frontmatter.current_phase = decision.nextPhase;
          job.frontmatter.iteration += 1;
          job.frontmatter.updated_at = new Date().toISOString();
          this.ctx.jobStore.save(job);
        }
        return {
          type: "pause",
          jobId,
          nextPhase: decision.nextPhase,
          phaseConfig: decision.nextPhaseConfig,
          reason: decision.reason,
        };
      }

      case "continue": {
        const entry = buildPhaseLogEntry(phaseName, condition, decision.nextPhase, message);
        job.body = appendPhaseLog(job.body, entry);
        job.frontmatter.current_phase = decision.nextPhase;
        job.frontmatter.iteration += 1;
        job.frontmatter.updated_at = new Date().toISOString();
        this.ctx.jobStore.save(job);
        return {
          type: "continue",
          jobId,
          nextPhase: decision.nextPhase,
          phaseConfig: decision.nextPhaseConfig,
        };
      }
    }
  }
}

export function checkCircularDependency(
  ctx: ProjectContext,
  jobId: string,
  dependsOn: string[],
): void {
  const visited = new Set<string>();
  const stack: string[] = [...dependsOn];

  while (stack.length > 0) {
    const depId = stack.pop()!;

    if (depId === jobId) {
      throw new CcsquadError("dag", "循環依存が検出されました");
    }

    if (visited.has(depId)) {
      continue;
    }
    visited.add(depId);

    try {
      const depJob = ctx.jobStore.load(depId);
      stack.push(...(depJob.frontmatter.depends_on ?? []));
    } catch {
      // Job not found, skip
    }
  }
}
