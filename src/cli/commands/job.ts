import type { Job } from "../../domain/types.js";
import { getPhase, parseTransitionCondition, validateConditionForPhase } from "../../domain/workflow.js";
import { CcsquadError } from "../../error.js";
import type { ProjectContext } from "../../app/project-context.js";
import { JobService, checkCircularDependency } from "../../app/job-service.js";
import type { TransitionResult } from "../../app/job-service.js";
import { truncate } from "../../util.js";

function printTransitionResult(result: TransitionResult): void {
  switch (result.type) {
    case "done":
      console.log(result.status === "completed"
        ? `ジョブが完了しました: ${result.jobId}`
        : `ジョブが失敗しました: ${result.jobId}`);
      break;
    case "continue":
      console.log(`フェーズを遷移しました: ${result.jobId} → ${result.nextPhase}`);
      break;
    case "pause":
      console.log(`一時停止: ${result.jobId} → ${result.nextPhase} (${result.reason})`);
      break;
  }
}

function getPhaseInfo(
  ctx: ProjectContext,
  job: Job,
): { type?: string; description?: string; agent?: string; reviewer?: string } | undefined {
  const phaseName = job.frontmatter.current_phase;
  if (!phaseName) return undefined;
  const wf = ctx.workflows[job.frontmatter.workflow];
  if (!wf) return undefined;
  const phase = getPhase(wf, phaseName);
  if (!phase) return undefined;
  return {
    type: phase.type,
    description: phase.description,
    agent: phase.agent,
    reviewer: phase.reviewer,
  };
}

export function cmdList(ctx: ProjectContext): void {
  const jobs = ctx.jobStore.listAll();
  if (jobs.length === 0) {
    console.log("ジョブはありません。");
    return;
  }
  console.log(
    `${"ID".padEnd(10)} ${"タイトル".padEnd(30)} ${"ワークフロー".padEnd(10)} ${"ステータス".padEnd(12)} ${"フェーズ".padEnd(12)} ${"優先度".padEnd(4)}`,
  );
  console.log("-".repeat(80));
  for (const job of jobs) {
    const fm = job.frontmatter;
    console.log(
      `${fm.id.padEnd(10)} ${truncate(fm.title, 28).padEnd(30)} ${fm.workflow.padEnd(10)} ${fm.status.padEnd(12)} ${(fm.current_phase ?? "-").padEnd(12)} ${String(fm.priority).padEnd(4)}`,
    );
  }
}

export function cmdShow(ctx: ProjectContext, id: string, format: "text" | "json"): void {
  const job = ctx.jobStore.load(id);

  if (format === "json") {
    const phaseInfo = getPhaseInfo(ctx, job);
    const output: Record<string, unknown> = {
      id: job.frontmatter.id,
      title: job.frontmatter.title,
      workflow: job.frontmatter.workflow,
      status: job.frontmatter.status,
      priority: job.frontmatter.priority,
      depends_on: job.frontmatter.depends_on,
      created_at: job.frontmatter.created_at,
      updated_at: job.frontmatter.updated_at,
      body: job.body,
    };
    if (job.frontmatter.current_phase !== undefined) {
      output.current_phase = job.frontmatter.current_phase;
    }
    if (phaseInfo !== undefined) {
      const phaseConfig: Record<string, unknown> = {};
      if (phaseInfo.type !== undefined) phaseConfig.type = phaseInfo.type;
      if (phaseInfo.description !== undefined) phaseConfig.description = phaseInfo.description;
      if (phaseInfo.agent !== undefined) phaseConfig.agent = phaseInfo.agent;
      if (phaseInfo.reviewer !== undefined) phaseConfig.reviewer = phaseInfo.reviewer;
      output.phase_config = phaseConfig;
    }
    console.log(JSON.stringify(output, null, 2));
  } else {
    const fm = job.frontmatter;
    console.log(`${fm.id}: ${fm.title}`);
    console.log(`ワークフロー: ${fm.workflow}`);
    console.log(`ステータス: ${fm.status}`);
    if (fm.current_phase) {
      console.log(`現在のフェーズ: ${fm.current_phase}`);
      const info = getPhaseInfo(ctx, job);
      if (info) {
        if (info.type) console.log(`  タイプ: ${info.type}`);
        if (info.description) console.log(`  説明: ${info.description}`);
        if (info.agent) console.log(`  エージェント: ${info.agent}`);
        if (info.reviewer) console.log(`  レビュアー: ${info.reviewer}`);
      }
    }
    console.log(`優先度: ${fm.priority}`);
    if (fm.depends_on && fm.depends_on.length > 0) {
      console.log(`依存: ${fm.depends_on.join(", ")}`);
    }
    console.log(`作成日時: ${fm.created_at}`);
    console.log(`更新日時: ${fm.updated_at}`);
    if (job.body.length > 0) {
      console.log();
      process.stdout.write(job.body);
    }
  }
}

export function cmdAdd(
  ctx: ProjectContext,
  title: string,
  workflow: string,
  description?: string,
  priority: number = 0,
  dependsOn: string[] = [],
): void {
  if (!ctx.workflows[workflow]) {
    throw new CcsquadError("config", `ワークフロー '${workflow}' が ccsquad.yaml に定義されていません`);
  }

  if (dependsOn.length > 0) {
    for (const depId of dependsOn) {
      ctx.jobStore.load(depId);
    }
    const nextId = ctx.jobStore.nextId();
    checkCircularDependency(ctx, nextId, dependsOn);
  }

  const jobService = new JobService(ctx);
  const job = jobService.create(title, workflow, { description, priority, dependsOn });
  console.log(`ジョブを作成しました: ${job.frontmatter.id}`);
}

export function cmdEdit(
  ctx: ProjectContext,
  id: string,
  title?: string,
  description?: string,
  priority?: number,
  dependsOn?: string[],
): void {
  const job = ctx.jobStore.load(id);

  if (title !== undefined) {
    job.frontmatter.title = title;
  }
  if (priority !== undefined) {
    job.frontmatter.priority = priority;
  }
  if (dependsOn !== undefined) {
    for (const depId of dependsOn) {
      ctx.jobStore.load(depId);
    }
    checkCircularDependency(ctx, id, dependsOn);
    job.frontmatter.depends_on = dependsOn;
  }
  if (description !== undefined) {
    const sectionHeader = "## 説明\n";
    const startIdx = job.body.indexOf(sectionHeader);
    if (startIdx !== -1) {
      const afterHeader = startIdx + sectionHeader.length;
      const nextSection = job.body.indexOf("\n## ", afterHeader);
      const sectionEnd = nextSection !== -1 ? nextSection : job.body.length;
      const before = job.body.slice(0, startIdx);
      const after = job.body.slice(sectionEnd);
      job.body = `${before}${sectionHeader}${description}\n${after}`;
    } else {
      const oldBody = job.body;
      job.body = `${sectionHeader}${description}\n${oldBody}`;
    }
  }

  job.frontmatter.updated_at = new Date().toISOString();
  ctx.jobStore.save(job);
  console.log(`ジョブを更新しました: ${id}`);
}

export function cmdUpdateSection(
  ctx: ProjectContext,
  id: string,
  section: string,
  content: string,
): void {
  const job = ctx.jobStore.load(id);

  const sectionHeader = `## ${section}`;
  const phaseLogHeader = "## フェーズログ";

  const sectionIdx = job.body.indexOf(sectionHeader);
  const phaseLogIdx = job.body.indexOf(phaseLogHeader);

  if (sectionIdx !== -1) {
    const afterHeader = sectionIdx + sectionHeader.length;
    const nextSection = job.body.indexOf("\n## ", afterHeader);
    const sectionEnd = nextSection !== -1 ? nextSection : job.body.length;
    const before = job.body.slice(0, sectionIdx);
    const after = job.body.slice(sectionEnd);
    job.body = `${before}${sectionHeader}\n${content}\n${after}`;
  } else if (phaseLogIdx !== -1) {
    const before = job.body.slice(0, phaseLogIdx);
    const after = job.body.slice(phaseLogIdx);
    job.body = `${before}${sectionHeader}\n${content}\n\n${after}`;
  } else {
    if (job.body.length > 0 && !job.body.endsWith("\n")) {
      job.body += "\n";
    }
    job.body += `\n${sectionHeader}\n${content}\n`;
  }

  job.frontmatter.updated_at = new Date().toISOString();
  ctx.jobStore.save(job);
  console.log(`ジョブのセクションを更新しました: ${id} (${section})`);
}

export function cmdRun(ctx: ProjectContext, id: string): void {
  const jobService = new JobService(ctx);
  const job = jobService.start(id);
  const phase = job.frontmatter.current_phase ?? "?";
  console.log(`ジョブを開始しました: ${id} (フェーズ: ${phase})`);
}

export function cmdTransition(ctx: ProjectContext, id: string, result: string, message: string): void {
  const jobService = new JobService(ctx);
  const condition = parseTransitionCondition(result);
  const txResult = jobService.transition(id, condition, message);
  printTransitionResult(txResult);
}

export function cmdApprove(ctx: ProjectContext, id: string, message: string): void {
  const jobService = new JobService(ctx);
  const txResult = jobService.transition(id, "approved", message);
  printTransitionResult(txResult);
}

export function cmdReject(ctx: ProjectContext, id: string, message: string): void {
  const jobService = new JobService(ctx);
  const txResult = jobService.transition(id, "rejected", message);
  printTransitionResult(txResult);
}

export function cmdAbort(ctx: ProjectContext, id: string): void {
  const jobService = new JobService(ctx);
  jobService.abort(id);
  console.log(`ジョブを中断しました: ${id}`);
}

export function cmdClose(ctx: ProjectContext, id: string): void {
  const jobService = new JobService(ctx);
  jobService.close(id);
  console.log(`ジョブをクローズしました: ${id}`);
}

export interface NextActionOutput {
  action: string;
  job_id: string;
  status?: string;
  phase?: string;
  phase_description?: string;
  agent?: string;
  reviewer?: string;
  reason?: string;
}

export function cmdNextAction(
  ctx: ProjectContext,
  id: string,
  result: string,
  message: string,
  resetIteration: boolean,
): void {
  if (resetIteration) {
    ctx.iterationStore.reset(id);
  }

  const job = ctx.jobStore.load(id);
  const wf = ctx.workflows[job.frontmatter.workflow];
  if (!wf) throw new CcsquadError("config", `ワークフロー '${job.frontmatter.workflow}' が見つかりません`);

  const phaseName = job.frontmatter.current_phase;
  if (!phaseName) throw new CcsquadError("workflow", "現在のフェーズが設定されていません");

  const phaseConfig = getPhase(wf, phaseName);
  if (!phaseConfig) throw new CcsquadError("workflow", `フェーズ '${phaseName}' が見つかりません`);

  const condition = parseTransitionCondition(result);
  validateConditionForPhase(phaseConfig.type, condition);

  const jobService = new JobService(ctx);
  const txResult = jobService.transition(id, condition, message);

  let output: NextActionOutput;

  switch (txResult.type) {
    case "done":
      output = { action: "done", job_id: id, status: txResult.status };
      break;
    case "pause":
      output = {
        action: "pause", job_id: id,
        phase: txResult.nextPhase,
        phase_description: txResult.phaseConfig.description,
        agent: txResult.phaseConfig.agent,
        reviewer: txResult.phaseConfig.reviewer,
        reason: txResult.reason,
      };
      break;
    case "continue":
      output = {
        action: "continue", job_id: id,
        phase: txResult.nextPhase,
        phase_description: txResult.phaseConfig.description,
        agent: txResult.phaseConfig.agent,
        reviewer: txResult.phaseConfig.reviewer,
      };
      break;
  }

  console.log(JSON.stringify(output, null, 2));
}
