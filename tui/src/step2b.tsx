import { createCliRenderer } from "@opentui/core";
import { createRoot, extend } from "@opentui/react";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";

extend({ "ghostty-terminal": GhosttyTerminalRenderable });

function App() {
  return (
    <box width="100%" height="100%" flexDirection="column" padding={2}>
      <text bold color="green">Step 2b: Testing ghostty-terminal alone</text>
      <box height={1} />
      <ghostty-terminal
        ansi={"\x1b[32mHello from ghostty!\x1b[0m\r\nLine 2"}
        cols={40}
        rows={5}
        width={42}
        height={7}
      />
      <box height={1} />
      <text color="gray">If you see green text above, it works. Ctrl+C to exit.</text>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);
