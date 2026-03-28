import type { PhaseConfig } from "../../domain/types.js";
import { COLOR_GRAY } from "../constants.js";

interface WorkflowDiagramProps {
  phases: PhaseConfig[];
  currentPhase?: string;
}

export function WorkflowDiagram({ phases, currentPhase }: WorkflowDiagramProps) {
  if (phases.length === 0) {
    return <text fg={COLOR_GRAY}>ワークフロー定義なし</text>;
  }

  const diagText = phases.map((p, i) => {
    const isCurrent = p.name === currentPhase;
    const marker = isCurrent ? "●" : "○";
    const arrow = i < phases.length - 1 ? " ─→ " : "";
    return `${marker} ${p.name}${arrow}`;
  }).join("");

  return <text fg={COLOR_GRAY}>{diagText}</text>;
}
