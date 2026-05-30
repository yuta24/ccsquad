import { CcsquadError } from "../error.js";
import type { Job, TransitionCondition, PhaseConfig, WorkflowConfig, PauseReason, AcceptanceCriterion } from "../domain/types.js";
import { getPhase, initialPhase } from "../domain/workflow.js";
import { computeTransition } from "../domain/state-machine.js";
import type { TransitionDecision } from "../domain/state-machine.js";
import { updateAcceptanceCriteria } from "../domain/acceptance-criteria.js";
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

  create(
    title: string,
    workflowConfig: WorkflowConfig,
    opts?: { description?: string; dependsOn?: string[]; maxIterations?: number; acceptanceCriteria?: AcceptanceCriterion[] },
  ): Job {
    const maxIterations = opts?.maxIterations ?? 10;
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      throw new CcsquadError(
        "job",
        `max_iterations は 1 以上の整数でなければなりません (値: ${maxIterations})`,
      );
    }

    const id = this.ctx.jobStore.nextId();
    const now = new Date().toISOString();

    const descBody = opts?.description ? `## 説明\n${opts.description}\n` : "";

    const job: Job = {
      frontmatter: {
        id,
        title,
        status: "pending",
        iteration: 0,
        max_iterations: maxIterations,
        depends_on: opts?.dependsOn ?? [],
        acceptance_criteria: opts?.acceptanceCriteria ?? [],
        workflow: workflowConfig,
        created_at: now,
        updated_at: now,
      },
      body: descBody,
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
      if (dep.frontmatter.status === "aborted" || dep.frontmatter.status === "failed") {
        throw new CcsquadError(
          "job",
          `依存ジョブ '${depId}' が ${dep.frontmatter.status} 状態のため実行できません。` +
          `このジョブを削除して依存関係を修正してください: ccsquad delete ${jobId}`,
        );
      }
      if (dep.frontmatter.status !== "completed") {
        throw new CcsquadError(
          "job",
          `依存ジョブ '${depId}' が未完了です (status: ${dep.frontmatter.status})`,
        );
      }
    }

    const wf = job.frontmatter.workflow;
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
    const wf = job.frontmatter.workflow;

    const decision = computeTransition({ job, workflow: wf, condition });
    const phaseName = job.frontmatter.current_phase!;

    return this.applyDecision(job, phaseName, condition, message, decision);
  }

  abort(jobId: string): Job {
    const job = this.loadJob(jobId);

    if (job.frontmatter.status !== "pending" && job.frontmatter.status !== "running" && job.frontmatter.status !== "paused") {
      throw new CcsquadError(
        "job",
        `ジョブ '${jobId}' は中断できません (status: ${job.frontmatter.status})`,
      );
    }

    job.frontmatter.status = "aborted";
    job.frontmatter.current_phase = undefined;
    job.frontmatter.pause_reason = undefined;
    job.frontmatter.iteration = 0;
    job.frontmatter.updated_at = new Date().toISOString();
    this.ctx.jobStore.save(job);
    return job;
  }

  update(
    jobId: string,
    opts: { title?: string; description?: string; workflowConfig?: WorkflowConfig; acceptanceCriteria?: AcceptanceCriterion[]; dependsOn?: string[] },
  ): Job {
    const job = this.loadJob(jobId);

    // バリデーションフェーズ（副作用なし）— 全チェックを先に行い、通過後にまとめて適用する
    if (opts.workflowConfig !== undefined && job.frontmatter.status !== "pending") {
      throw new CcsquadError(
        "job",
        `ジョブ '${jobId}' は pending 状態でないためワークフローを変更できません (status: ${job.frontmatter.status})。` +
        `ジョブを中断して新しいジョブを作成してください: ccsquad abort ${jobId} && ccsquad create "タイトル" --workflow <新しいワークフロー>`,
      );
    }

    if (opts.dependsOn !== undefined) {
      if (job.frontmatter.status !== "pending") {
        throw new CcsquadError(
          "job",
          `ジョブ '${jobId}' は pending 状態でないため依存関係を変更できません (status: ${job.frontmatter.status})`,
        );
      }
      checkCircularDependency(this.ctx, jobId, opts.dependsOn);
    }

    // 適用フェーズ
    if (opts.workflowConfig !== undefined) {
      job.frontmatter.workflow = opts.workflowConfig;
    }
    if (opts.dependsOn !== undefined) {
      job.frontmatter.depends_on = opts.dependsOn;
    }
    if (opts.title !== undefined) {
      job.frontmatter.title = opts.title;
    }
    if (opts.description !== undefined) {
      job.body = replaceDescriptionSection(job.body, opts.description);
    }
    if (opts.acceptanceCriteria !== undefined) {
      job.frontmatter.acceptance_criteria = opts.acceptanceCriteria;
    }

    job.frontmatter.updated_at = new Date().toISOString();
    this.ctx.jobStore.save(job);
    return job;
  }

  delete(jobId: string, force: boolean = false): void {
    const job = this.loadJob(jobId);

    if (!force && (job.frontmatter.status === "running" || job.frontmatter.status === "paused")) {
      throw new CcsquadError(
        "job",
        `ジョブ '${jobId}' は ${job.frontmatter.status} 状態です。削除するには --force を指定してください: ccsquad delete --force ${jobId}`,
      );
    }

    const allJobs = this.ctx.jobStore.listAll();
    const dependents = allJobs.filter(
      (j) => j.frontmatter.id !== jobId && (j.frontmatter.depends_on ?? []).includes(jobId),
    );
    if (dependents.length > 0 && !force) {
      const ids = dependents.map((j) => j.frontmatter.id).join(", ");
      throw new CcsquadError(
        "job",
        `ジョブ '${jobId}' は他のジョブ (${ids}) から参照されています。先に参照元を削除するか、--force で強制削除してください`,
      );
    }

    this.ctx.jobStore.delete(jobId);
    this.ctx.logStore.delete(jobId);
  }

  get(jobId: string): Job {
    return this.loadJob(jobId);
  }

  private applyDecision(
    job: Job,
    phaseName: string,
    condition: TransitionCondition,
    message: string,
    decision: TransitionDecision,
  ): TransitionResult {
    const jobId = job.frontmatter.id;

    // review フェーズからの遷移時、reviewer メッセージで AC の done 状態を更新
    const currentPhaseConfig = getPhase(job.frontmatter.workflow, phaseName);
    if (currentPhaseConfig?.type === "review" && job.frontmatter.acceptance_criteria.length > 0) {
      job.frontmatter.acceptance_criteria = updateAcceptanceCriteria(
        job.frontmatter.acceptance_criteria,
        message,
      );
    }

    switch (decision.action) {
      case "complete":
      case "abort": {
        const targetStatus = decision.action === "complete" ? "completed" : "failed";
        job.frontmatter.status = targetStatus;
        job.frontmatter.current_phase = undefined;
        job.frontmatter.pause_reason = undefined;
        job.frontmatter.iteration = 0;
        job.frontmatter.updated_at = new Date().toISOString();
        this.ctx.jobStore.save(job);
        return { type: "done", jobId, status: targetStatus };
      }

      case "pause": {
        job.frontmatter.status = "paused";
        job.frontmatter.pause_reason = decision.reason;
        if (decision.reason === "human_review") {
          job.frontmatter.current_phase = decision.nextPhase;
        }
        job.frontmatter.updated_at = new Date().toISOString();
        this.ctx.jobStore.save(job);
        return {
          type: "pause",
          jobId,
          nextPhase: decision.nextPhase,
          phaseConfig: decision.nextPhaseConfig,
          reason: decision.reason,
        };
      }

      case "continue": {
        job.frontmatter.status = "running";
        job.frontmatter.current_phase = decision.nextPhase;
        job.frontmatter.pause_reason = undefined;
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

export function replaceDescriptionSection(body: string, description: string): string {
  const newSection = `## 説明\n${description}\n`;
  // ^## with m flag matches line start; (?=^## ) lookahead stops at the next heading's line start,
  // so the match always includes its trailing \n. Fallback branch greedily matches to end of string.
  const existing = /^## 説明\n[\s\S]*?(?=^## )|^## 説明\n[\s\S]*/m;
  if (existing.test(body)) {
    return body.replace(existing, newSection);
  }
  return newSection + body;
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
      throw new CcsquadError("job", "循環依存が検出されました");
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
