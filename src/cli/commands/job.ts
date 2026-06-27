import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { Job, JobStatus, WorkflowConfig, AcceptanceCriterion, PauseReason } from "../../domain/types.js";
import { ALL_JOB_STATUSES } from "../../domain/types.js";
import { getPhase, parseTransitionCondition, parseWorkflowObject, WORKFLOW_PRESETS } from "../../domain/workflow.js";
import { CcsquadError } from "../../error.js";
import type { ProjectContext } from "../../app/project-context.js";
import { JobService } from "../../app/job-service.js";
import type { TransitionResult } from "../../app/job-service.js";
import { truncate, padRight } from "../../util.js";
import { buildJobPrompt } from "../../app/prompt-builder.js";

// ── Input parsers ──

// Parse --workflow input: preset name, .ccsquad/workflows/<name>.yaml, JSON/YAML string, file path, or "-" (stdin)
export function parseWorkflowInput(input: string, squadDir?: string): WorkflowConfig {
  // Check preset names first
  if (WORKFLOW_PRESETS[input]) {
    return parseWorkflowObject(YAML.parse(WORKFLOW_PRESETS[input]));
  }

  // Check .ccsquad/workflows/<name>.yaml when squadDir is provided and input looks like a plain name
  if (squadDir && !input.includes("/") && !input.includes("\\") && !input.includes(":") && input !== "-") {
    const namedPath = join(squadDir, "workflows", `${input}.yaml`);
    if (existsSync(namedPath)) {
      return parseWorkflowObject(YAML.parse(readFileSync(namedPath, "utf-8")));
    }
  }

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

// Parse --plan-file input: ファイルパス
export function parsePlanFileInput(path: string): string {
  if (!existsSync(path)) {
    throw new CcsquadError("config", `計画文書のファイルが見つかりません: ${path}`);
  }
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    throw new CcsquadError("io", `計画文書の読み込みエラー: ${e}`);
  }
}

// ── Output helpers ──

function printTransitionResult(result: TransitionResult): void {
  switch (result.type) {
    case "done":
      process.stderr.write(
        result.status === "completed"
          ? `ジョブが完了しました: ${result.jobId}\n`
          : `ジョブが失敗しました: ${result.jobId}\n`,
      );
      break;
    case "continue": {
      process.stderr.write(`フェーズを遷移しました: ${result.jobId} → ${result.nextPhase}\n`);
      const cmds = buildSuggestedCommands(result.jobId, result.phaseConfig.type, "running");
      process.stderr.write(`次のアクション:\n${cmds.map((c) => `  ${c}`).join("\n")}\n`);
      break;
    }
    case "pause": {
      process.stderr.write(`一時停止: ${result.jobId} → ${result.nextPhase} (${result.reason})\n`);
      const cmds = buildSuggestedCommands(result.jobId, result.phaseConfig.type, "paused", result.reason);
      process.stderr.write(`次のアクション:\n${cmds.map((c) => `  ${c}`).join("\n")}\n`);
      break;
    }
  }
}

// ── Commands ──

// create: ジョブを作成する（旧 init）
// stdout: job ID のみ（パイプ対応）
// stderr: 人間向けメッセージ
export function cmdCreate(
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
  }

  const jobService = new JobService(ctx);
  const job = jobService.create(title, workflowConfig, { description, dependsOn, maxIterations, acceptanceCriteria });
  process.stdout.write(job.frontmatter.id + "\n");
  process.stderr.write(`作成: ${job.frontmatter.id}\n`);
}

// run: ジョブを開始する (pending → running)
export function cmdRun(ctx: ProjectContext, id: string): void {
  const jobService = new JobService(ctx);
  const job = jobService.start(id);
  const phase = job.frontmatter.current_phase ?? "?";
  process.stderr.write(`ジョブを開始しました: ${id} (フェーズ: ${phase})\n`);
  process.stderr.write(`次のアクション:\n  ccsquad prompt ${id}\n`);
}

// prompt: 現在のフェーズのプロンプトを stdout に出力する（旧 next）
// 戻り値: exit code
//   0 = プロンプト出力（実行継続）
//   2 = 人間レビュー待ち
//   3 = ジョブ終了
export function cmdPrompt(ctx: ProjectContext, id: string): number {
  const job = ctx.jobStore.load(id);

  if (job.frontmatter.status === "completed" || job.frontmatter.status === "failed" || job.frontmatter.status === "aborted") {
    process.stderr.write(`ジョブ '${id}' は終了しています (status: ${job.frontmatter.status})\n`);
    return 3;
  }

  if (job.frontmatter.status === "paused") {
    const phaseConfig = job.frontmatter.current_phase ? getPhase(job.frontmatter.workflow, job.frontmatter.current_phase) : undefined;
    const phaseType = phaseConfig?.type ?? "execute";
    if (job.frontmatter.pause_reason === "human_review") {
      process.stderr.write(`レビュー待ち: 人間のレビューが必要です (${id})\n`);
    } else {
      process.stderr.write(`最大イテレーション到達: 人間の判断が必要です (${id})\n`);
    }
    const cmds = buildSuggestedCommands(id, phaseType, "paused", job.frontmatter.pause_reason);
    process.stderr.write(`次のアクション:\n${cmds.map((c) => `  ${c}`).join("\n")}\n`);
    return 2;
  }

  if (job.frontmatter.status === "pending") {
    process.stderr.write(`ジョブ '${id}' はまだ開始されていません。先に実行してください: ccsquad run ${id}\n`);
    return 3;
  }

  if (job.frontmatter.status !== "running") {
    throw new CcsquadError("job", `ジョブ '${id}' は実行中ではありません (status: ${job.frontmatter.status})`);
  }

  const logContent = ctx.logStore.read(id);
  const planContent = ctx.planStore.read(id);
  process.stdout.write(buildJobPrompt(job, logContent, planContent));
  return 0;
}

// done: フェーズを遷移する（旧 pass）
// --message はフェーズログに自動記録される（遷移成功後）
// --plan-file は plan フェーズの計画文書として .ccsquad/plans/<id>.md に記録される（遷移成功後）
export function cmdDone(ctx: ProjectContext, id: string, result: string, message: string, workflowConfig?: WorkflowConfig, planContent?: string): void {
  const condition = parseTransitionCondition(result);

  const job = ctx.jobStore.load(id);
  const phase = job.frontmatter.current_phase ?? "unknown";

  if (planContent !== undefined) {
    const phaseConfig = getPhase(job.frontmatter.workflow, phase);
    if (phaseConfig?.type !== "plan") {
      throw new CcsquadError(
        "job",
        `--plan-file は plan フェーズでのみ使用できます (現在: ${phaseConfig?.type ?? "unknown"})`,
      );
    }
  }

  const jobService = new JobService(ctx);
  const txResult = jobService.transition(id, condition, message, workflowConfig);

  // 遷移成功後に記録（遷移失敗時は記録しない）
  if (message) {
    ctx.logStore.append(id, phase, message);
  }
  if (planContent !== undefined) {
    ctx.planStore.write(id, planContent);
  }

  printTransitionResult(txResult);
}

// abort: ジョブを中断する
export function cmdAbort(ctx: ProjectContext, id: string, message?: string): void {
  const job = ctx.jobStore.load(id);
  const phase = job.frontmatter.current_phase ?? "unknown";

  const jobService = new JobService(ctx);
  jobService.abort(id);

  if (message) {
    ctx.logStore.append(id, phase, message);
  }

  process.stderr.write(`ジョブを中断しました: ${id}\n`);
}

// delete: ジョブを削除する
export function cmdDelete(ctx: ProjectContext, id: string, opts?: { force?: boolean }): void {
  const jobService = new JobService(ctx);
  jobService.delete(id, opts?.force ?? false);
  process.stderr.write(`ジョブを削除しました: ${id}\n`);
}

// log: フェーズログを表示する
export function cmdShowLog(ctx: ProjectContext, id: string): void {
  ctx.jobStore.load(id); // ジョブ存在チェック
  const content = ctx.logStore.read(id);
  if (content === null) {
    process.stderr.write(`ジョブ '${id}' のログはありません\n`);
    return;
  }
  process.stdout.write(content);
}

// update: ジョブを更新する
export function cmdUpdate(
  ctx: ProjectContext,
  id: string,
  opts: { title?: string; description?: string; workflowConfig?: WorkflowConfig; acceptanceCriteria?: AcceptanceCriterion[]; dependsOn?: string[] },
): void {
  if (opts.dependsOn !== undefined) {
    for (const depId of opts.dependsOn) {
      ctx.jobStore.load(depId);
    }
  }
  const jobService = new JobService(ctx);
  const job = jobService.update(id, opts);
  process.stderr.write(`ジョブを更新しました: ${job.frontmatter.id}\n`);
}

// list: ジョブ一覧を表示する
export function cmdList(ctx: ProjectContext, opts?: { status?: string; excludeStatus?: string; format?: "text" | "json" }): void {
  if (opts?.status && opts?.excludeStatus) {
    throw new CcsquadError("config", "--status と --exclude-status は同時に指定できません");
  }

  let includeSet: Set<string> | undefined;
  if (opts?.status) {
    const included = opts.status.split(",").map((s) => s.trim()).filter(Boolean);
    for (const s of included) {
      if (!ALL_JOB_STATUSES.includes(s as JobStatus)) {
        throw new CcsquadError("config", `不正なステータス: ${s} (${ALL_JOB_STATUSES.join(", ")} のいずれかを指定してください)`);
      }
    }
    includeSet = new Set<string>(included);
  }

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
  if (includeSet) {
    jobs = jobs.filter((j) => includeSet!.has(j.frontmatter.status));
  } else if (excludeSet) {
    jobs = jobs.filter((j) => !excludeSet!.has(j.frontmatter.status));
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

// show: ジョブ詳細を表示する
export function cmdShow(ctx: ProjectContext, id: string, format: "text" | "json" | "prompt"): void {
  const job = ctx.jobStore.load(id);

  if (format === "prompt") {
    const logContent = ctx.logStore.read(id);
    const planContent = ctx.planStore.read(id);
    process.stdout.write(buildJobPrompt(job, logContent, planContent));
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
      plan: ctx.planStore.read(id),
    };
    if (job.frontmatter.current_phase !== undefined) {
      output.current_phase = job.frontmatter.current_phase;
      const wf = job.frontmatter.workflow;
      const phase = getPhase(wf, job.frontmatter.current_phase);
      if (phase) {
        output.phase_config = {
          type: phase.type,
          ...(phase.agents ? { agents: phase.agents } : { agent: phase.agent }),
          auto: phase.auto ?? false,
        };
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
        const agentDisplay = phase.agents
          ? `並列実行 (${phase.agents.map((a) => a.agent).join(", ")})`
          : phase.agent ?? "（未定義）";
        console.log(`  エージェント: ${agentDisplay}`);
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
    const planContent = ctx.planStore.read(id);
    if (planContent !== null) {
      console.log();
      console.log(`## 計画 (${ctx.planStore.planPath(id)})`);
      console.log();
      process.stdout.write(planContent);
    }
  }
}

// ── backward-compat aliases (deprecated) ──

/** @deprecated cmdCreate を使用してください */
export const cmdInit = cmdCreate;
/** @deprecated cmdDone を使用してください */
export const cmdPass = cmdDone;
/** @deprecated フェーズログは cmdDone --message に統合されました */
export const cmdLog = (ctx: ProjectContext, id: string, message: string): void => {
  const job = ctx.jobStore.load(id);
  const phase = job.frontmatter.current_phase ?? "unknown";
  ctx.logStore.append(id, phase, message);
};

// ── suggested commands helper ──

function buildSuggestedCommands(
  id: string,
  phaseType: string,
  status: string,
  pauseReason?: PauseReason,
): string[] {
  if (status === "paused" && pauseReason === "human_review") {
    return [
      `# レビュー待ち — 人間が以下を実行する`,
      `ccsquad done ${id} approved  --message "承認理由"`,
      `ccsquad done ${id} rejected  --message "却下理由（未達 AC と改善指示を明記）"`,
    ];
  }

  if (status === "paused" && pauseReason === "max_iterations") {
    return [
      `# 最大イテレーション到達 — 人間が判断する`,
      `ccsquad done ${id} completed --message "完了と判断した理由"`,
      `ccsquad done ${id} failed    --message "失敗と判断した理由"`,
      `ccsquad abort ${id}`,
    ];
  }

  if (phaseType === "interview") {
    return [
      `ccsquad done ${id} completed --message "## 質問\\n1. （質問内容）\\n   理由: ..."`,
      `ccsquad done ${id} failed    --message "失敗理由"`,
    ];
  }

  if (phaseType === "plan") {
    return [
      `ccsquad update ${id} --ac '[{"description":"基準1"},{"description":"基準2"}]'`,
      `ccsquad done ${id} completed --plan-file <計画文書のパス> --message "計画内容の要約"`,
      `ccsquad done ${id} failed    --message "失敗理由"`,
    ];
  }

  if (phaseType === "execute") {
    return [
      `ccsquad done ${id} completed --message "実装内容の要約"`,
      `ccsquad done ${id} failed    --message "失敗理由"`,
    ];
  }

  // review (auto)
  return [
    `ccsquad done ${id} approved  --message "承認理由"`,
    `ccsquad done ${id} rejected  --message "却下理由（未達 AC と改善指示を明記）"`,
  ];
}

// ── Type exports (for tests) ──
export type { Job, JobStatus };
