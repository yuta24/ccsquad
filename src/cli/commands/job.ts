import { readFileSync, existsSync } from "node:fs";
import YAML from "yaml";
import type { Job, JobStatus, WorkflowConfig, AcceptanceCriterion, PauseReason } from "../../domain/types.js";
import { ALL_JOB_STATUSES } from "../../domain/types.js";
import { getPhase, parseTransitionCondition, parseWorkflowObject } from "../../domain/workflow.js";
import { CcsquadError } from "../../error.js";
import type { ProjectContext } from "../../app/project-context.js";
import { JobService, checkCircularDependency } from "../../app/job-service.js";
import type { TransitionResult } from "../../app/job-service.js";
import { truncate, padRight } from "../../util.js";
import { buildJobPrompt } from "../../app/prompt-builder.js";

// Parse --workflow input: JSON/YAML string, file path, or "-" (stdin)
export function parseWorkflowInput(input: string): WorkflowConfig {
  let raw: string;

  if (input === "-") {
    raw = readFileSync(0, "utf-8");
  } else if (!input.trimStart().startsWith("{") && !input.trimStart().startsWith("---") && !input.includes(":") && existsSync(input)) {
    raw = readFileSync(input, "utf-8");
  } else if (existsSync(input)) {
    raw = readFileSync(input, "utf-8");
  } else {
    raw = input;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    throw new CcsquadError("config", "ワークフロー定義の YAML/JSON パースに失敗しました");
  }

  return parseWorkflowObject(parsed);
}

// Parse --ac input: JSON/YAML string, file path, or "-" (stdin)
export function parseAcInput(input: string): AcceptanceCriterion[] {
  let raw: string;

  if (input === "-") {
    raw = readFileSync(0, "utf-8");
  } else if (!input.trimStart().startsWith("[") && !input.trimStart().startsWith("-") && existsSync(input)) {
    raw = readFileSync(input, "utf-8");
  } else if (existsSync(input)) {
    raw = readFileSync(input, "utf-8");
  } else {
    raw = input;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    throw new CcsquadError("config", "Acceptance Criteria の YAML/JSON パースに失敗しました");
  }

  if (!Array.isArray(parsed)) {
    throw new CcsquadError("config", "Acceptance Criteria は配列で指定してください");
  }

  return parsed.map((item: unknown, i: number) => {
    if (typeof item === "string") {
      return { description: item, done: false };
    }
    if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>).description !== "string") {
      throw new CcsquadError("config", `Acceptance Criteria[${i}] は { description: string, done?: boolean } または文字列で指定してください`);
    }
    const ac = item as Record<string, unknown>;
    return { description: String(ac.description), done: ac.done === true };
  });
}

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

export function cmdList(ctx: ProjectContext, opts?: { excludeStatus?: string; format?: "text" | "json" }): void {
  let excludeSet: Set<string> | undefined;
  if (opts?.excludeStatus) {
    const excluded = opts.excludeStatus.split(",").map((s) => s.trim()).filter(Boolean);
    for (const s of excluded) {
      if (!ALL_JOB_STATUSES.includes(s as JobStatus)) {
        throw new CcsquadError("config", `不正なステータス: ${s} (${ALL_JOB_STATUSES.join(", ")} のいずれかを指定してください)`);
      }
    }
    excludeSet = new Set<string>(excluded);
  }

  let jobs = ctx.jobStore.listAll();
  if (excludeSet) {
    jobs = jobs.filter((j) => !excludeSet.has(j.frontmatter.status));
  }

  if (opts?.format === "json") {
    const output = jobs.map((j) => ({
      id: j.frontmatter.id,
      title: j.frontmatter.title,
      status: j.frontmatter.status,
      current_phase: j.frontmatter.current_phase ?? null,
      iteration: j.frontmatter.iteration,
      max_iterations: j.frontmatter.max_iterations,
      depends_on: j.frontmatter.depends_on ?? [],
      created_at: j.frontmatter.created_at,
      updated_at: j.frontmatter.updated_at,
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (jobs.length === 0) {
    console.log("ジョブはありません。");
    return;
  }
  console.log(
    `${padRight("ID", 10)} ${padRight("タイトル", 30)} ${padRight("ステータス", 12)} ${padRight("フェーズ", 12)}`,
  );
  console.log("-".repeat(66));
  for (const job of jobs) {
    const fm = job.frontmatter;
    console.log(
      `${padRight(fm.id, 10)} ${padRight(truncate(fm.title, 28), 30)} ${padRight(fm.status, 12)} ${padRight(fm.current_phase ?? "-", 12)}`,
    );
  }
}

export function cmdShow(ctx: ProjectContext, id: string, format: "text" | "json" | "prompt"): void {
  const job = ctx.jobStore.load(id);

  if (format === "prompt") {
    const logContent = ctx.logStore.read(id);
    process.stdout.write(buildJobPrompt(job, logContent));
    return;
  }

  if (format === "json") {
    const output: Record<string, unknown> = {
      id: job.frontmatter.id,
      title: job.frontmatter.title,
      status: job.frontmatter.status,
      iteration: job.frontmatter.iteration,
      max_iterations: job.frontmatter.max_iterations,
      depends_on: job.frontmatter.depends_on,
      acceptance_criteria: job.frontmatter.acceptance_criteria,
      created_at: job.frontmatter.created_at,
      updated_at: job.frontmatter.updated_at,
      body: job.body,
    };
    if (job.frontmatter.current_phase !== undefined) {
      output.current_phase = job.frontmatter.current_phase;
      const wf = job.frontmatter.workflow;
      const phase = getPhase(wf, job.frontmatter.current_phase);
      if (phase) {
        output.phase_config = { type: phase.type, agent: phase.agent, auto: phase.auto ?? false };
        output.suggested_commands = buildSuggestedCommands(
          id,
          phase.type,
          job.frontmatter.status,
          job.frontmatter.pause_reason,
        );
      }
    }
    if (job.frontmatter.pause_reason !== undefined) {
      output.pause_reason = job.frontmatter.pause_reason;
    }
    console.log(JSON.stringify(output, null, 2));
  } else {
    const fm = job.frontmatter;
    console.log(`${fm.id}: ${fm.title}`);
    console.log(`ステータス: ${fm.status}${fm.pause_reason ? ` (${fm.pause_reason})` : ""}`);
    if (fm.current_phase) {
      console.log(`現在のフェーズ: ${fm.current_phase}`);
      const wf = fm.workflow;
      const phase = getPhase(wf, fm.current_phase);
      if (phase) {
        console.log(`  タイプ: ${phase.type}`);
        console.log(`  エージェント: ${phase.agent}`);
      }
    }
    console.log(`イテレーション: ${fm.iteration}/${fm.max_iterations}`);
    if (fm.depends_on && fm.depends_on.length > 0) {
      console.log(`依存: ${fm.depends_on.join(", ")}`);
    }
    if (fm.acceptance_criteria.length > 0) {
      console.log(`Acceptance Criteria:`);
      for (const ac of fm.acceptance_criteria) {
        console.log(`  [${ac.done ? "x" : " "}] ${ac.description}`);
      }
    }
    console.log(`作成日時: ${fm.created_at}`);
    console.log(`更新日時: ${fm.updated_at}`);
    if (job.body.length > 0) {
      console.log();
      process.stdout.write(job.body);
    }
  }
}

// init: ジョブを作成する（旧 job add）
export function cmdInit(
  ctx: ProjectContext,
  title: string,
  workflowConfig: WorkflowConfig,
  description?: string,
  dependsOn: string[] = [],
  maxIterations: number = 10,
  acceptanceCriteria?: AcceptanceCriterion[],
): void {
  if (dependsOn.length > 0) {
    for (const depId of dependsOn) {
      ctx.jobStore.load(depId);
    }
    const nextId = ctx.jobStore.nextId();
    checkCircularDependency(ctx, nextId, dependsOn);
  }

  const jobService = new JobService(ctx);
  const job = jobService.create(title, workflowConfig, { description, dependsOn, maxIterations, acceptanceCriteria });
  console.log(`ジョブを作成しました: ${job.frontmatter.id}`);
}

// run: ジョブを開始する (pending → running)
export function cmdRun(ctx: ProjectContext, id: string): void {
  const jobService = new JobService(ctx);
  const job = jobService.start(id);
  const phase = job.frontmatter.current_phase ?? "?";
  console.log(`ジョブを開始しました: ${id} (フェーズ: ${phase})`);
}

// next: プロンプトを stdout に出力する（読み取り専用）
export function cmdNext(ctx: ProjectContext, id: string): void {
  const job = ctx.jobStore.load(id);

  if (job.frontmatter.status !== "running" && job.frontmatter.status !== "paused") {
    throw new CcsquadError("job", `ジョブ '${id}' は実行中ではありません (status: ${job.frontmatter.status})`);
  }

  const logContent = ctx.logStore.read(id);
  process.stdout.write(buildJobPrompt(job, logContent));
}

// pass: フェーズを遷移する（旧 job transition）
export function cmdPass(ctx: ProjectContext, id: string, result: string, message: string): void {
  const jobService = new JobService(ctx);
  const condition = parseTransitionCondition(result);
  const txResult = jobService.transition(id, condition, message);
  printTransitionResult(txResult);
}

export function cmdAbort(ctx: ProjectContext, id: string): void {
  const jobService = new JobService(ctx);
  jobService.abort(id);
  console.log(`ジョブを中断しました: ${id}`);
}

export function cmdUpdate(
  ctx: ProjectContext,
  id: string,
  opts: { title?: string; description?: string; workflowConfig?: WorkflowConfig; acceptanceCriteria?: AcceptanceCriterion[] },
): void {
  const jobService = new JobService(ctx);
  const job = jobService.update(id, opts);
  console.log(`ジョブを更新しました: ${job.frontmatter.id}`);
}

export function cmdLog(ctx: ProjectContext, id: string, message: string): void {
  const job = ctx.jobStore.load(id);
  const phase = job.frontmatter.current_phase ?? "unknown";
  ctx.logStore.append(id, phase, message);
}

function buildSuggestedCommands(
  id: string,
  phaseType: string,
  status: string,
  pauseReason?: PauseReason,
): string[] {
  if (status === "paused" && pauseReason === "human_review") {
    return [
      `# レビュー待ち — 人間が以下を実行する`,
      `ccsquad pass ${id} approved  --message "承認理由"`,
      `ccsquad pass ${id} rejected  --message "却下理由（未達 AC と改善指示を明記）"`,
    ];
  }

  if (status === "paused" && pauseReason === "max_iterations") {
    return [
      `# 最大イテレーション到達 — 人間が判断する`,
      `ccsquad pass ${id} completed --message "完了と判断した理由"`,
      `ccsquad pass ${id} failed    --message "失敗と判断した理由"`,
      `ccsquad abort ${id}`,
    ];
  }

  if (phaseType === "plan") {
    return [
      `ccsquad update ${id} --ac '[{"description":"基準1"},{"description":"基準2"}]'`,
      `ccsquad log ${id} "調査・設計の内容"`,
      `ccsquad pass ${id} completed --message "計画内容の要約"`,
      `ccsquad pass ${id} failed    --message "失敗理由"`,
    ];
  }

  if (phaseType === "execute") {
    return [
      `ccsquad log ${id} "実装内容のサマリー"`,
      `ccsquad pass ${id} completed --message "実装内容の要約"`,
      `ccsquad pass ${id} failed    --message "失敗理由"`,
    ];
  }

  // review (auto)
  return [
    `ccsquad log ${id} "レビュー結果のサマリー"`,
    `ccsquad pass ${id} approved  --message "承認理由"`,
    `ccsquad pass ${id} rejected  --message "却下理由（未達 AC と改善指示を明記）"`,
  ];
}
