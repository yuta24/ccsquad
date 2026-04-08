import { readFileSync, existsSync } from "node:fs";
import YAML from "yaml";
import type { Job, JobStatus, PhaseType, PhaseConfig, TransitionCondition, WorkflowConfig, AgentSpec, AcceptanceCriterion } from "../../domain/types.js";
import { ALL_PHASE_TYPES, ALL_CONDITIONS, ALL_JOB_STATUSES, resolveAgent, resolveAgents, isMultiAgent } from "../../domain/types.js";
import { getPhase, parseTransitionCondition, parseWorkflowObject } from "../../domain/workflow.js";
import { CcsquadError } from "../../error.js";
import type { ProjectContext } from "../../app/project-context.js";
import { JobService, checkCircularDependency } from "../../app/job-service.js";
import type { TransitionResult } from "../../app/job-service.js";
import { truncate, padRight } from "../../util.js";
import { computeMetrics, formatMetricsText, formatMetricsJson } from "../../domain/metrics.js";

// Parse --workflow input: JSON/YAML string, file path, or "-" (stdin)
export function parseWorkflowInput(input: string): WorkflowConfig {
  let raw: string;

  if (input === "-") {
    raw = readFileSync(0, "utf-8");
  } else if (!input.trimStart().startsWith("{") && !input.trimStart().startsWith("---") && !input.includes(":") && existsSync(input)) {
    // Looks like a file path (no JSON/YAML markers and file exists)
    raw = readFileSync(input, "utf-8");
  } else if (existsSync(input)) {
    // Ambiguous but file exists — treat as file
    raw = readFileSync(input, "utf-8");
  } else {
    // Treat as inline JSON/YAML string
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

// Parse "agent1[constraint1]+agent2[constraint2]" or "agent1+agent2" into AgentSpec[]
function parseAgentSpecs(raw: string): AgentSpec[] {
  const specs: AgentSpec[] = [];
  // Split on '+' that is NOT inside brackets
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (ch === "+" && depth === 0) {
      tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  tokens.push(current);

  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed === "") {
      throw new CcsquadError("config", `エージェント名に空文字列が含まれています: ${raw}`);
    }
    const bracketIdx = trimmed.indexOf("[");
    if (bracketIdx === -1) {
      specs.push({ agent: trimmed });
    } else {
      if (!trimmed.endsWith("]")) {
        throw new CcsquadError("config", `constraint の閉じ括弧がありません: ${trimmed}`);
      }
      const agent = trimmed.slice(0, bracketIdx).trim();
      const constraint = trimmed.slice(bracketIdx + 1, -1).trim();
      if (agent === "") {
        throw new CcsquadError("config", `エージェント名に空文字列が含まれています: ${raw}`);
      }
      specs.push(constraint ? { agent, constraint } : { agent });
    }
  }

  if (specs.length < 2) {
    throw new CcsquadError("config", `マルチエージェントは + で 2 件以上指定してください: ${raw}`);
  }
  return specs;
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
      priority: j.frontmatter.priority,
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
    `${padRight("ID", 10)} ${padRight("タイトル", 30)} ${padRight("ステータス", 12)} ${padRight("フェーズ", 12)} ${padRight("優先度", 4)}`,
  );
  console.log("-".repeat(70));
  for (const job of jobs) {
    const fm = job.frontmatter;
    console.log(
      `${padRight(fm.id, 10)} ${padRight(truncate(fm.title, 28), 30)} ${padRight(fm.status, 12)} ${padRight(fm.current_phase ?? "-", 12)} ${padRight(String(fm.priority), 4)}`,
    );
  }
}

export function cmdShow(ctx: ProjectContext, id: string, format: "text" | "json"): void {
  const job = ctx.jobStore.load(id);
  const logContent = ctx.phaseLogStore.read(id);
  const metrics = computeMetrics(job, logContent);

  if (format === "json") {
    const output: Record<string, unknown> = {
      id: job.frontmatter.id,
      title: job.frontmatter.title,
      status: job.frontmatter.status,
      iteration: job.frontmatter.iteration,
      max_iterations: job.frontmatter.max_iterations,
      priority: job.frontmatter.priority,
      depends_on: job.frontmatter.depends_on,
      acceptance_criteria: job.frontmatter.acceptance_criteria,
      created_at: job.frontmatter.created_at,
      updated_at: job.frontmatter.updated_at,
      body: job.body,
      phase_log: logContent,
    };
    if (job.frontmatter.current_phase !== undefined) {
      output.current_phase = job.frontmatter.current_phase;
      const wf = job.frontmatter.workflow;
      const phase = getPhase(wf, job.frontmatter.current_phase);
      if (phase) {
        if (isMultiAgent(phase)) {
          output.phase_config = { type: phase.type, agents: resolveAgents(phase), auto: phase.auto ?? false };
        } else {
          output.phase_config = { type: phase.type, agent: resolveAgent(phase), auto: phase.auto ?? false };
        }
      }
    }
    if (job.frontmatter.pause_reason !== undefined) {
      output.pause_reason = job.frontmatter.pause_reason;
    }
    if (metrics) {
      output.metrics = formatMetricsJson(metrics);
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
        if (isMultiAgent(phase)) {
          console.log(`  エージェント: ${resolveAgents(phase).map((s) => s.agent).join(", ")}`);
        } else {
          console.log(`  エージェント: ${resolveAgent(phase)}`);
        }
      }
    }
    console.log(`イテレーション: ${fm.iteration}/${fm.max_iterations}`);
    console.log(`優先度: ${fm.priority}`);
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
    if (metrics) {
      console.log();
      console.log(formatMetricsText(metrics));
    }
    if (job.body.length > 0) {
      console.log();
      process.stdout.write(job.body);
    }
    if (logContent.length > 0) {
      console.log();
      console.log("## フェーズログ");
      process.stdout.write(logContent);
    }
  }
}

export function cmdAdd(
  ctx: ProjectContext,
  title: string,
  workflowConfig: WorkflowConfig,
  description?: string,
  priority: number = 0,
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
  const job = jobService.create(title, workflowConfig, { description, priority, dependsOn, maxIterations, acceptanceCriteria });
  console.log(`ジョブを作成しました: ${job.frontmatter.id}`);
}

export function buildWorkflowConfig(phasesStr: string, transitionsStr: string): WorkflowConfig {
  // Parse phases: "research:plan,design:plan:planner,code:execute,explore:execute:explorer+explorer,review:review:auto"
  const phaseDefs = phasesStr.split(",").map((pair) => {
    const trimmed = pair.trim();
    const parts = trimmed.split(":");
    if (parts.length < 3 || parts.length > 4) {
      throw new CcsquadError("config", `フェーズ定義の形式が不正です: ${trimmed} (name:type:agent, name:type:agent1[constraint1]+agent2[constraint2], name:type:agent:auto の形式で指定してください)`);
    }
    const name = parts[0].trim();
    const type = parts[1].trim();

    // Determine agent/agents and auto from remaining parts
    let agent: string | undefined;
    let agents: AgentSpec[] | undefined;
    let auto = false;
    if (parts.length >= 3) {
      const third = parts[2].trim();
      if (third === "auto") {
        throw new CcsquadError("config", `フェーズ '${name}': エージェントを指定してください (name:type:agent:auto の形式)`);
      } else if (third.includes("+")) {
        agents = parseAgentSpecs(third);
      } else {
        agent = third || undefined;
      }
    }
    if (parts.length === 4) {
      const fourth = parts[3].trim();
      if (fourth === "auto") {
        auto = true;
      } else {
        throw new CcsquadError("config", `4 番目の部分は "auto" のみ有効です: ${fourth}`);
      }
    }

    if (!ALL_PHASE_TYPES.includes(type as PhaseType)) {
      throw new CcsquadError("config", `不正なフェーズタイプ: ${type} (${ALL_PHASE_TYPES.join(", ")} を指定してください)`);
    }
    return { name, type: type as PhaseType, agent, agents, auto };
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
  const phases: PhaseConfig[] = phaseDefs.map(({ name, type, agent, agents, auto }) => {
    const on: Partial<Record<TransitionCondition, string>> = {};
    for (const t of transitionDefs) {
      if (t.phase === name) {
        on[t.condition] = t.target;
      }
    }
    return { name, type, ...(agent ? { agent } : {}), ...(agents ? { agents } : {}), ...(auto ? { auto } : {}), on };
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

export function cmdAbort(ctx: ProjectContext, id: string): void {
  const jobService = new JobService(ctx);
  jobService.abort(id);
  console.log(`ジョブを中断しました: ${id}`);
}

export function cmdUpdate(
  ctx: ProjectContext,
  id: string,
  opts: { title?: string; priority?: number; description?: string; workflowConfig?: WorkflowConfig; acceptanceCriteria?: AcceptanceCriterion[] },
): void {
  const jobService = new JobService(ctx);
  const job = jobService.update(id, opts);
  console.log(`ジョブを更新しました: ${job.frontmatter.id}`);
}

// ── job tree ──

interface TreeNode {
  id: string;
  title: string;
  status: string;
  children: TreeNode[];
}

function buildTreeStructure(jobs: Job[]): {
  jobMap: Map<string, Job>;
  children: Map<string, string[]>;
  roots: string[];
} {
  const jobMap = new Map<string, Job>();
  const children = new Map<string, string[]>();

  for (const job of jobs) {
    jobMap.set(job.frontmatter.id, job);
    if (!children.has(job.frontmatter.id)) {
      children.set(job.frontmatter.id, []);
    }
  }

  for (const job of jobs) {
    for (const depId of job.frontmatter.depends_on ?? []) {
      if (!jobMap.has(depId)) {
        process.stderr.write(`警告: ジョブ ${job.frontmatter.id} の依存 ${depId} が見つかりません\n`);
        continue;
      }
      children.get(depId)!.push(job.frontmatter.id);
    }
  }

  const roots = jobs
    .filter((j) => (j.frontmatter.depends_on ?? []).every((dep) => !jobMap.has(dep)))
    .map((j) => j.frontmatter.id)
    .sort();

  return { jobMap, children, roots };
}

function printTreeNode(
  id: string,
  jobMap: Map<string, Job>,
  children: Map<string, string[]>,
  prefix: string,
  isLast: boolean,
  ancestors: Set<string>,
): void {
  const job = jobMap.get(id);
  if (!job) return;
  const fm = job.frontmatter;
  const connector = isLast ? "└── " : "├── ";
  if (ancestors.has(id)) {
    console.log(`${prefix}${connector}${fm.id}  ${truncate(fm.title, 24)}  [${fm.status}]  (cycle)`);
    return;
  }
  console.log(`${prefix}${connector}${fm.id}  ${truncate(fm.title, 24)}  [${fm.status}]`);
  const next = new Set(ancestors);
  next.add(id);
  const childIds = (children.get(id) ?? []).slice().sort();
  const childPrefix = prefix + (isLast ? "    " : "│   ");
  for (let i = 0; i < childIds.length; i++) {
    printTreeNode(childIds[i], jobMap, children, childPrefix, i === childIds.length - 1, next);
  }
}

function buildJsonNode(
  id: string,
  jobMap: Map<string, Job>,
  children: Map<string, string[]>,
  ancestors: Set<string>,
): TreeNode | null {
  const job = jobMap.get(id);
  if (!job) return null;
  const fm = job.frontmatter;
  if (ancestors.has(id)) {
    return { id: fm.id, title: fm.title, status: fm.status, children: [] };
  }
  const next = new Set(ancestors);
  next.add(id);
  return {
    id: fm.id,
    title: fm.title,
    status: fm.status,
    children: (children.get(id) ?? [])
      .slice()
      .sort()
      .map((childId) => buildJsonNode(childId, jobMap, children, next))
      .filter((n): n is TreeNode => n !== null),
  };
}

export function cmdTree(ctx: ProjectContext, format: "text" | "json"): void {
  const jobs = ctx.jobStore.listAll();

  if (jobs.length === 0) {
    if (format === "json") {
      console.log(JSON.stringify([], null, 2));
    } else {
      console.log("ジョブはありません。");
    }
    return;
  }

  const { jobMap, children, roots } = buildTreeStructure(jobs);

  if (format === "json") {
    const tree = roots
      .map((id) => buildJsonNode(id, jobMap, children, new Set()))
      .filter((n): n is TreeNode => n !== null);
    console.log(JSON.stringify(tree, null, 2));
    return;
  }

  for (const id of roots) {
    const fm = jobMap.get(id)!.frontmatter;
    console.log(`${fm.id}  ${truncate(fm.title, 24)}  [${fm.status}]`);
    const ancestors = new Set([id]);
    const childIds = (children.get(id) ?? []).slice().sort();
    for (let j = 0; j < childIds.length; j++) {
      printTreeNode(childIds[j], jobMap, children, "", j === childIds.length - 1, ancestors);
    }
  }
}
