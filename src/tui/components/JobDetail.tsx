import { createMemo } from "solid-js";
import type { DagStatusJob } from "../types.js";

interface JobDetailProps {
  job: DagStatusJob | null;
  jobBody: string;
  focused: boolean;
}

export function JobDetail(props: JobDetailProps) {
  const title = createMemo(() => {
    const id = props.job?.id ?? "---";
    return ` Detail: ${id}${props.focused ? " [*]" : ""} `;
  });

  const content = createMemo(() => {
    const job = props.job;
    if (!job) return "Select a job to view details";

    const lines: string[] = [
      `ID:      ${job.id}`,
      `Title:   ${job.title}`,
      `Status:  ${job.status}`,
      `Phase:   ${job.current_phase ?? "-"}`,
      `Iter:    ${job.iteration}`,
      `Worktree: ${job.worktree_exists ? "yes" : "no"}`,
      "",
      "--- Body ---",
      "",
      props.jobBody || "(no body loaded)",
    ];
    return lines.join("\n");
  });

  return (
    <box
      border
      title={title()}
      style={{
        flexGrow: 1,
        borderColor: props.focused ? "cyan" : "gray",
      }}
    >
      <scrollbox focused={props.focused} style={{ flexGrow: 1 }}>
        <text fg="white">{content()}</text>
      </scrollbox>
    </box>
  );
}
