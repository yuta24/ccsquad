import { CcsquadError } from "../error.js";
import type {
  WorkflowConfig,
  PhaseConfig,
  PhaseType,
  TransitionCondition,
} from "./types.js";
import { ALL_CONDITIONS, ALL_PHASE_TYPES } from "./types.js";

// ── Query functions ──

export function initialPhase(wf: WorkflowConfig): PhaseConfig {
  if (wf.phases.length === 0) {
    throw new CcsquadError("config", "ワークフローにフェーズが定義されていません");
  }
  return wf.phases[0];
}

export function getPhase(wf: WorkflowConfig, name: string): PhaseConfig | undefined {
  return wf.phases.find((p) => p.name === name);
}

export function resolveTransition(
  wf: WorkflowConfig,
  phaseName: string,
  condition: TransitionCondition,
): string {
  const phase = getPhase(wf, phaseName);
  if (!phase) {
    throw new CcsquadError("workflow", `フェーズ '${phaseName}' がワークフローに定義されていません`);
  }
  const next = phase.on[condition];
  if (next === undefined) {
    throw new CcsquadError(
      "workflow",
      `フェーズ '${phaseName}' に条件 '${condition}' に一致するルールがありません`,
    );
  }
  return next;
}

// ── Utilities ──

export function parseTransitionCondition(s: string): TransitionCondition {
  if (ALL_CONDITIONS.includes(s as TransitionCondition)) {
    return s as TransitionCondition;
  }
  throw new CcsquadError("workflow", `不明な遷移条件です: ${s}`);
}

export function validateConditionForPhase(
  phaseType: PhaseType,
  condition: TransitionCondition,
): void {
  if (phaseType === "review") {
    if (condition !== "approved" && condition !== "rejected") {
      throw new CcsquadError("workflow", "レビューフェーズでは approved/rejected を使用してください");
    }
  } else if (condition === "approved" || condition === "rejected") {
    throw new CcsquadError("workflow", "通常フェーズでは completed/failed を使用してください");
  }
}

// ── Workflow parser (from job body) ──

export function parseWorkflowFromBody(body: string): WorkflowConfig {
  const section = extractWorkflowSection(body);
  if (!section) {
    throw new CcsquadError("workflow", "ジョブに Workflow セクションが定義されていません");
  }

  const phases: PhaseConfig[] = [];
  const lines = section.split("\n").filter((l) => l.trim().startsWith("-"));

  for (const line of lines) {
    // "- research: plan -> completed:design, failed:ABORT"
    const content = line.replace(/^-\s*/, "").trim();
    const arrowMatch = content.split(/\s*(?:→|->)\s*/);
    if (arrowMatch.length !== 2) {
      throw new CcsquadError("workflow", `不正なフェーズ定義です: ${line.trim()}`);
    }
    const [nameType, transitionsStr] = arrowMatch;
    const colonIdx = nameType.indexOf(":");
    if (colonIdx === -1) {
      throw new CcsquadError("workflow", `フェーズ名とタイプの区切り ':' がありません: ${nameType}`);
    }
    const name = nameType.slice(0, colonIdx).trim();
    const typeAndAgent = nameType.slice(colonIdx + 1).trim();

    // [agent] ブラケット記法をパース: "plan [planner]" or "plan"
    const bracketMatch = typeAndAgent.match(/^(\S+)\s+\[(\S+)\]$/);
    const type = bracketMatch ? bracketMatch[1] : typeAndAgent;
    const agent = bracketMatch ? bracketMatch[2] : undefined;

    if (!ALL_PHASE_TYPES.includes(type as PhaseType)) {
      throw new CcsquadError("workflow", `不正なフェーズタイプ: ${type} (${ALL_PHASE_TYPES.join(", ")} を指定してください)`);
    }

    const on: Partial<Record<TransitionCondition, string>> = {};
    for (const pair of transitionsStr.split(",")) {
      const trimmed = pair.trim();
      const pairColonIdx = trimmed.indexOf(":");
      if (pairColonIdx === -1) {
        throw new CcsquadError("workflow", `遷移ルールの形式が不正です: ${trimmed}`);
      }
      const cond = trimmed.slice(0, pairColonIdx).trim();
      const target = trimmed.slice(pairColonIdx + 1).trim();
      if (!ALL_CONDITIONS.includes(cond as TransitionCondition)) {
        throw new CcsquadError("workflow", `不明な遷移条件です: ${cond}`);
      }
      on[cond as TransitionCondition] = target;
    }

    phases.push({ name, type: type as PhaseType, ...(agent ? { agent } : {}), on });
  }

  if (phases.length === 0) {
    throw new CcsquadError("workflow", "Workflow セクションにフェーズが定義されていません");
  }

  return { phases };
}

export function generateWorkflowSection(wf: WorkflowConfig): string {
  let result = "## Workflow\n\n";
  for (const phase of wf.phases) {
    const transitions = Object.entries(phase.on)
      .map(([cond, target]) => `${cond}:${target}`)
      .join(", ");
    const agentPart = phase.agent ? ` [${phase.agent}]` : "";
    result += `- ${phase.name}: ${phase.type}${agentPart} -> ${transitions}\n`;
  }
  return result;
}

function extractWorkflowSection(body: string): string | null {
  const header = /^## Workflow\s*$/m;
  const match = body.match(header);
  if (!match || match.index === undefined) return null;

  const start = match.index + match[0].length;
  const nextHeader = body.indexOf("\n## ", start);
  if (nextHeader !== -1) {
    return body.slice(start, nextHeader);
  }
  return body.slice(start);
}
