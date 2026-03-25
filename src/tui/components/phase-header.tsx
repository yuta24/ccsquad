import type { WorkflowConfig } from "../../config.js";
import type { Job } from "../../job.js";
import { ATTR_BOLD, COLOR_CYAN, COLOR_GRAY, truncateStr } from "../constants.js";

interface PhaseHeaderProps {
  job: Job;
  workflowConfig: WorkflowConfig | undefined;
  iteration: number;
}

export function PhaseHeader({ job, workflowConfig, iteration }: PhaseHeaderProps) {
  const fm = job.frontmatter;
  const phases = workflowConfig?.phases ?? [];

  const titleLine = `${fm.id} | ${truncateStr(fm.title, 40)} | ワークフロー: ${fm.workflow} | イテレーション: ${iteration}`;
  const diagText = phases.map((p, i) => {
    const isCurrent = p.name === fm.current_phase;
    const marker = isCurrent ? "●" : "○";
    const arrow = i < phases.length - 1 ? " ─→ " : "";
    return `${marker} ${p.name}${arrow}`;
  }).join("");

  return (
    <box width="100%" borderStyle="single" borderColor={COLOR_CYAN}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <text fg={COLOR_CYAN} attributes={ATTR_BOLD}>{titleLine}</text>
        <text fg={COLOR_GRAY}>{diagText || "フェーズなし"}</text>
      </box>
    </box>
  );
}
