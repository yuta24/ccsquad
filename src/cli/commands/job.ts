import type { Job, PhaseType, PhaseConfig, TransitionCondition, WorkflowConfig } from "../../domain/types.js";
import { ALL_PHASE_TYPES, ALL_CONDITIONS, resolveAgent } from "../../domain/types.js";
import { getPhase, parseTransitionCondition, parseWorkflowFromBody } from "../../domain/workflow.js";
import { CcsquadError } from "../../error.js";
import type { ProjectContext } from "../../app/project-context.js";
import { JobService, checkCircularDependency } from "../../app/job-service.js";
import type { TransitionResult } from "../../app/job-service.js";
import { truncate } from "../../util.js";
import { computeMetrics, formatMetricsText, formatMetricsJson } from "../../domain/metrics.js";

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

export function cmdList(ctx: ProjectContext): void {
  const jobs = ctx.jobStore.listAll();
  if (jobs.length === 0) {
    console.log("ジョブはありません。");
    return;
  }
  console.log(
    `${"ID".padEnd(10)} ${"タイトル".padEnd(30)} ${"ステータス".padEnd(12)} ${"フェーズ".padEnd(12)} ${"優先度".padEnd(4)}`,
  );
  console.log("-".repeat(70));
  for (const job of jobs) {
    const fm = job.frontmatter;
    console.log(
      `${fm.id.padEnd(10)} ${truncate(fm.title, 28).padEnd(30)} ${fm.status.padEnd(12)} ${(fm.current_phase ?? "-").padEnd(12)} ${String(fm.priority).padEnd(4)}`,
    );
  }
}

export function cmdShow(ctx: ProjectContext, id: string, format: "text" | "json"): void {
  const job = ctx.jobStore.load(id);

  if (format === "json") {
    const output: Record<string, unknown> = {
      id: job.frontmatter.id,
      title: job.frontmatter.title,
      status: job.frontmatter.status,
      iteration: job.frontmatter.iteration,
      max_iterations: job.frontmatter.max_iterations,
      priority: job.frontmatter.priority,
      depends_on: job.frontmatter.depends_on,
      created_at: job.frontmatter.created_at,
      updated_at: job.frontmatter.updated_at,
      body: job.body,
    };
    if (job.frontmatter.current_phase !== undefined) {
      output.current_phase = job.frontmatter.current_phase;
      try {
        const wf = parseWorkflowFromBody(job.body);
        const phase = getPhase(wf, job.frontmatter.current_phase);
        if (phase) {
          output.phase_config = { type: phase.type, agent: resolveAgent(phase), auto: phase.auto ?? false };
        }
      } catch {
        // skip if workflow parse fails
      }
    }
    console.log(JSON.stringify(output, null, 2));
  } else {
    const fm = job.frontmatter;
    console.log(`${fm.id}: ${fm.title}`);
    console.log(`ステータス: ${fm.status}`);
    if (fm.current_phase) {
      console.log(`現在のフェーズ: ${fm.current_phase}`);
      try {
        const wf = parseWorkflowFromBody(job.body);
        const phase = getPhase(wf, fm.current_phase);
        if (phase) {
          console.log(`  タイプ: ${phase.type}`);
          console.log(`  エージェント: ${resolveAgent(phase)}`);
        }
      } catch {
        // skip
      }
    }
    console.log(`イテレーション: ${fm.iteration}/${fm.max_iterations}`);
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
  phasesStr: string,
  transitionsStr: string,
  description?: string,
  priority: number = 0,
  dependsOn: string[] = [],
  maxIterations: number = 10,
): void {
  const workflowConfig = buildWorkflowConfig(phasesStr, transitionsStr);

  if (dependsOn.length > 0) {
    for (const depId of dependsOn) {
      ctx.jobStore.load(depId);
    }
    const nextId = ctx.jobStore.nextId();
    checkCircularDependency(ctx, nextId, dependsOn);
  }

  const jobService = new JobService(ctx);
  const job = jobService.create(title, workflowConfig, { description, priority, dependsOn, maxIterations });
  console.log(`ジョブを作成しました: ${job.frontmatter.id}`);
}

function buildWorkflowConfig(phasesStr: string, transitionsStr: string): WorkflowConfig {
  // Parse phases: "research:plan,design:plan:planner,code:execute,review:review:auto,review:review:reviewer:auto"
  const phaseDefs = phasesStr.split(",").map((pair) => {
    const trimmed = pair.trim();
    const parts = trimmed.split(":");
    if (parts.length < 2 || parts.length > 4) {
      throw new CcsquadError("config", `フェーズ定義の形式が不正です: ${trimmed} (name:type, name:type:agent, name:type:auto, name:type:agent:auto の形式で指定してください)`);
    }
    const name = parts[0].trim();
    const type = parts[1].trim();

    // Determine agent and auto from remaining parts
    let agent: string | undefined;
    let auto = false;
    if (parts.length >= 3) {
      const third = parts[2].trim();
      if (third === "auto") {
        auto = true;
      } else {
        agent = third || undefined;
      }
    }
    if (parts.length === 4) {
      const fourth = parts[3].trim();
      if (fourth === "auto") {
        auto = true;
      }
    }

    if (!ALL_PHASE_TYPES.includes(type as PhaseType)) {
      throw new CcsquadError("config", `不正なフェーズタイプ: ${type} (${ALL_PHASE_TYPES.join(", ")} を指定してください)`);
    }
    return { name, type: type as PhaseType, agent, auto };
  });

  // Parse transitions: "research:completed>design,research:failed>ABORT,..."
  const transitionDefs = transitionsStr.split(",").map((item) => {
    const trimmed = item.trim();
    const gtIdx = trimmed.indexOf(">");
    if (gtIdx === -1) {
      throw new CcsquadError("config", `遷移ルールの形式が不正です: ${trimmed} (phase:condition>target の形式で指定してください)`);
    }
    const phaseCondition = trimmed.slice(0, gtIdx);
    const target = trimmed.slice(gtIdx + 1).trim();
    const colonIdx = phaseCondition.indexOf(":");
    if (colonIdx === -1) {
      throw new CcsquadError("config", `遷移ルールの形式が不正です: ${trimmed}`);
    }
    const phase = phaseCondition.slice(0, colonIdx).trim();
    const condition = phaseCondition.slice(colonIdx + 1).trim();
    if (!ALL_CONDITIONS.includes(condition as TransitionCondition)) {
      throw new CcsquadError("config", `不明な遷移条件です: ${condition}`);
    }
    return { phase, condition: condition as TransitionCondition, target };
  });

  // Build PhaseConfig array
  const phases: PhaseConfig[] = phaseDefs.map(({ name, type, agent, auto }) => {
    const on: Partial<Record<TransitionCondition, string>> = {};
    for (const t of transitionDefs) {
      if (t.phase === name) {
        on[t.condition] = t.target;
      }
    }
    return { name, type, ...(agent ? { agent } : {}), ...(auto ? { auto } : {}), on };
  });

  return { phases };
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

export function cmdSummary(ctx: ProjectContext, id: string, format: "text" | "json"): void {
  const job = ctx.jobStore.load(id);
  const metrics = computeMetrics(job);

  if (metrics === null) {
    if (format === "json") {
      console.log(JSON.stringify({ id: job.frontmatter.id, error: "フェーズログがありません" }, null, 2));
    } else {
      console.log(`${job.frontmatter.id}: ${job.frontmatter.title}`);
      console.log(`ステータス: ${job.frontmatter.status}`);
      console.log("フェーズログがありません。");
    }
    return;
  }

  if (format === "json") {
    console.log(JSON.stringify(formatMetricsJson(metrics), null, 2));
  } else {
    console.log(formatMetricsText(metrics));
  }
}
