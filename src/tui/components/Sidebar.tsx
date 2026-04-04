import { For, createMemo } from "solid-js";
import type { DagStatusJob } from "../types.js";

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return ">";
    case "completed":
      return "*";
    case "failed":
      return "!";
    case "pending":
      return "-";
    case "paused":
      return "|";
    case "aborted":
      return "x";
    default:
      return "?";
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return "cyan";
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "pending":
      return "gray";
    case "paused":
      return "yellow";
    case "aborted":
      return "red";
    default:
      return "white";
  }
}

interface SidebarProps {
  jobs: DagStatusJob[];
  selectedIndex: number;
  focused: boolean;
}

export function Sidebar(props: SidebarProps) {
  const items = createMemo(() => props.jobs);

  return (
    <box
      border
      title={props.focused ? " Jobs [*] " : " Jobs "}
      style={{
        width: 36,
        flexShrink: 0,
        borderColor: props.focused ? "cyan" : "gray",
      }}
    >
      <scrollbox style={{ flexGrow: 1 }}>
        <text>
          <For each={items()}>
            {(job, index) => {
              const isSelected = () => index() === props.selectedIndex;
              const icon = () => statusIcon(job.status);
              const color = () => statusColor(job.status);
              const phase = () => job.current_phase ?? "-";
              const prefix = () => (isSelected() ? "> " : "  ");
              const line = () =>
                `${prefix()}${icon()} ${job.id} ${job.status.padEnd(9)} ${phase()}`;
              return (
                <>
                  <span
                    style={{
                      color: isSelected() ? "white" : color(),
                      backgroundColor: isSelected() ? "blue" : undefined,
                      bold: isSelected(),
                    }}
                  >
                    {line()}
                  </span>
                  <br />
                </>
              );
            }}
          </For>
          {items().length === 0 && (
            <span style={{ color: "gray" }}>No jobs found</span>
          )}
        </text>
      </scrollbox>
    </box>
  );
}
