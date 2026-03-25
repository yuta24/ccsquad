import type { SquadConfig, WorkflowConfig } from "../config.js";
import { parseTransitionCondition } from "../config.js";
import type { Job } from "../job.js";
import { JobStore } from "../job.js";
import { WorkflowEngine, checkCircularDependency } from "../engine.js";
import type { IterationStore } from "../iteration.js";
import { CcsquadError } from "../error.js";
import { resolveAndExecuteTransition, validateConditionForPhase } from "../service/transition.js";

// --- helper functions ---

function getWorkflow(config: SquadConfig, job: Job): WorkflowConfig {
  const wf = config.getWorkflow(job.frontmatter.workflow);
  if (!wf) {
    throw new CcsquadError(
      "config",
      `ワークフロー '${job.frontmatter.workflow}' が ccsquad.yaml に定義されていません`,
    );
  }
  return wf;
}

function printTransitionResult(job: Job): void {
  const fm = job.frontmatter;
  switch (fm.status) {
    case "completed":
      console.log(`ジョブが完了しました: ${fm.id}`);
      break;
    case "failed":
      console.log(`ジョブが失敗しました: ${fm.id}`);
      break;
    case "running": {
      const phase = fm.current_phase ?? "?";
      console.log(`フェーズを遷移しました: ${fm.id} → ${phase}`);
      break;
    }
    case "closed":
      console.log(`ジョブがクローズされました: ${fm.id}`);
      break;
    default:
      break;
  }
}

function truncate(s: string, maxLen: number): string {
  if ([...s].length <= maxLen) {
    return s;
  }
  return [...s].slice(0, maxLen - 2).join("") + "..";
}

function getPhaseInfo(
  config: SquadConfig,
  job: Job,
): { description?: string; agent?: string; reviewer?: string } | undefined {
  const phaseName = job.frontmatter.current_phase;
  if (!phaseName) return undefined;
  const wf = config.getWorkflow(job.frontmatter.workflow);
  if (!wf) return undefined;
  const phase = wf.getPhase(phaseName);
  if (!phase) return undefined;
  return {
    description: phase.description,
    agent: phase.agent,
    reviewer: phase.reviewer,
  };
}

// --- exported command functions ---

export function cmdList(store: JobStore): void {
  const jobs = store.listAll();
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

export function cmdShow(
  store: JobStore,
  config: SquadConfig,
  id: string,
  format: "text" | "json",
): void {
  const job = store.load(id);

  if (format === "json") {
    const phaseInfo = getPhaseInfo(config, job);
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
      const info = getPhaseInfo(config, job);
      if (info) {
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
  store: JobStore,
  config: SquadConfig,
  title: string,
  workflow: string,
  description?: string,
  priority: number = 0,
  dependsOn: string[] = [],
): void {
  if (!config.getWorkflow(workflow)) {
    throw new CcsquadError(
      "config",
      `ワークフロー '${workflow}' が ccsquad.yaml に定義されていません`,
    );
  }

  const id = store.nextId();

  if (dependsOn.length > 0) {
    for (const depId of dependsOn) {
      store.load(depId);
    }
    checkCircularDependency(store, id, dependsOn);
  }

  const now = new Date().toISOString();
  const body = description ? `## 説明\n${description}\n` : "";

  const job: Job = {
    frontmatter: {
      id,
      title,
      workflow,
      status: "pending",
      current_phase: undefined,
      priority,
      depends_on: dependsOn,
      created_at: now,
      updated_at: now,
    },
    body,
  };

  store.save(job);
  console.log(`ジョブを作成しました: ${id}`);
}

export function cmdEdit(
  store: JobStore,
  id: string,
  title?: string,
  description?: string,
  priority?: number,
  dependsOn?: string[],
): void {
  const job = store.load(id);

  if (title !== undefined) {
    job.frontmatter.title = title;
  }
  if (priority !== undefined) {
    job.frontmatter.priority = priority;
  }
  if (dependsOn !== undefined) {
    for (const depId of dependsOn) {
      store.load(depId);
    }
    checkCircularDependency(store, id, dependsOn);
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
  store.save(job);
  console.log(`ジョブを更新しました: ${id}`);
}

export function cmdRun(store: JobStore, config: SquadConfig, id: string): void {
  const job = store.load(id);
  const wf = getWorkflow(config, job);

  const engine = new WorkflowEngine(wf, store);
  const updatedJob = engine.startJob(id);
  const phase = updatedJob.frontmatter.current_phase ?? "?";
  console.log(`ジョブを開始しました: ${id} (フェーズ: ${phase})`);
}

export function cmdTransition(
  store: JobStore,
  config: SquadConfig,
  id: string,
  result: string,
  message: string,
): void {
  const condition = parseTransitionCondition(result);
  const job = store.load(id);
  const wf = getWorkflow(config, job);
  const engine = new WorkflowEngine(wf, store);

  const updatedJob = engine.transition(id, condition, message);
  printTransitionResult(updatedJob);
}

export function cmdApprove(
  store: JobStore,
  config: SquadConfig,
  id: string,
  message: string,
): void {
  const job = store.load(id);
  const wf = getWorkflow(config, job);
  const engine = new WorkflowEngine(wf, store);

  const updatedJob = engine.approve(id, message);
  printTransitionResult(updatedJob);
}

export function cmdReject(
  store: JobStore,
  config: SquadConfig,
  id: string,
  message: string,
): void {
  const job = store.load(id);
  const wf = getWorkflow(config, job);
  const engine = new WorkflowEngine(wf, store);

  const updatedJob = engine.reject(id, message);
  printTransitionResult(updatedJob);
}

export function cmdAbort(store: JobStore, config: SquadConfig, id: string): void {
  const job = store.load(id);
  const wf = getWorkflow(config, job);
  const engine = new WorkflowEngine(wf, store);

  engine.abortJob(id);
  console.log(`ジョブを中断しました: ${id}`);
}

export function cmdClose(
  store: JobStore,
  config: SquadConfig,
  iterationStore: IterationStore,
  id: string,
): void {
  const job = store.load(id);
  const wf = getWorkflow(config, job);
  const engine = new WorkflowEngine(wf, store);

  engine.closeJob(id);
  iterationStore.remove(id);
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
  store: JobStore,
  config: SquadConfig,
  iterationStore: IterationStore,
  id: string,
  result: string,
  message: string,
  resetIteration: boolean,
): void {
  if (resetIteration) {
    iterationStore.reset(id);
  }

  const job = store.load(id);
  const wf = getWorkflow(config, job);
  const phaseName = job.frontmatter.current_phase;
  if (!phaseName) {
    throw new CcsquadError("workflow", "現在のフェーズが設定されていません");
  }

  const condition = parseTransitionCondition(result);
  validateConditionForPhase(wf, phaseName, condition);

  const txResult = resolveAndExecuteTransition(wf, store, iterationStore, id, condition, message);

  let output: NextActionOutput;

  switch (txResult.type) {
    case "done":
      output = {
        action: "done",
        job_id: id,
        status: txResult.status,
      };
      break;
    case "pause":
      output = {
        action: "pause",
        job_id: id,
        phase: txResult.nextPhase,
        phase_description: txResult.phaseConfig.description,
        agent: txResult.phaseConfig.agent,
        reviewer: txResult.phaseConfig.reviewer,
        reason: txResult.reason,
      };
      break;
    case "continue":
      output = {
        action: "continue",
        job_id: id,
        phase: txResult.nextPhase,
        phase_description: txResult.phaseConfig.description,
        agent: txResult.phaseConfig.agent,
        reviewer: txResult.phaseConfig.reviewer,
      };
      break;
  }

  console.log(JSON.stringify(output, null, 2));
}
