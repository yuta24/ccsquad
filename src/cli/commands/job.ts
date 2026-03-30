import type { Job, PhaseType, PhaseConfig, TransitionCondition, WorkflowConfig, AgentSpec } from "../../domain/types.js";
import { ALL_PHASE_TYPES, ALL_CONDITIONS, resolveAgent, resolveAgents, isMultiAgent } from "../../domain/types.js";
import { getPhase, parseTransitionCondition, parseWorkflowFromBody } from "../../domain/workflow.js";
import { CcsquadError } from "../../error.js";
import type { ProjectContext } from "../../app/project-context.js";
import { JobService, checkCircularDependency } from "../../app/job-service.js";
import type { TransitionResult } from "../../app/job-service.js";
import { truncate } from "../../util.js";
import { computeMetrics, formatMetricsText, formatMetricsJson } from "../../domain/metrics.js";

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
          if (isMultiAgent(phase)) {
            output.phase_config = { type: phase.type, agents: resolveAgents(phase), auto: phase.auto ?? false };
          } else {
            output.phase_config = { type: phase.type, agent: resolveAgent(phase), auto: phase.auto ?? false };
          }
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
          if (isMultiAgent(phase)) {
            console.log(`  エージェント: ${resolveAgents(phase).map((s) => s.agent).join(", ")}`);
          } else {
            console.log(`  エージェント: ${resolveAgent(phase)}`);
          }
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
  // Parse phases: "research:plan,design:plan:planner,code:execute,explore:execute:explorer+explorer,review:review:auto"
  const phaseDefs = phasesStr.split(",").map((pair) => {
    const trimmed = pair.trim();
    const parts = trimmed.split(":");
    if (parts.length < 2 || parts.length > 4) {
      throw new CcsquadError("config", `フェーズ定義の形式が不正です: ${trimmed} (name:type, name:type:agent, name:type:agent1[constraint1]+agent2[constraint2], name:type:auto, name:type:agent:auto の形式で指定してください)`);
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
        auto = true;
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

export function cmdUpdate(
  ctx: ProjectContext,
  id: string,
  opts: { title?: string; priority?: number; description?: string },
): void {
  const jobService = new JobService(ctx);
  const job = jobService.update(id, opts);
  console.log(`ジョブを更新しました: ${job.frontmatter.id}`);
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
