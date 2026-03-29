import { createMemo } from "solid-js";

interface LogPanelProps {
  jobId: string;
  logContent: string;
  focused: boolean;
}

export function LogPanel(props: LogPanelProps) {
  const title = createMemo(
    () => ` Log: ${props.jobId}${props.focused ? " [*]" : ""} `,
  );
  const ansi = createMemo(() => props.logContent || "(no log output yet)");

  return (
    <box
      border
      title={title()}
      style={{
        flexGrow: 1,
        borderColor: props.focused ? "cyan" : "gray",
      }}
    >
      <scrollbox focused={props.focused} stickyScroll stickyStart="bottom" style={{ flexGrow: 1 }}>
        <ghostty-terminal ansi={ansi()} cols={120} rows={40} />
      </scrollbox>
    </box>
  );
}
