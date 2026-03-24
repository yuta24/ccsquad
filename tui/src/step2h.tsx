import { createCliRenderer } from "@opentui/core";
import { createRoot, extend } from "@opentui/react";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";

extend({ "ghostty-terminal": GhosttyTerminalRenderable });

// Same layout as step2g but WITHOUT ghostty-terminal
function App() {
  return (
    <box width="100%" height="100%" flexDirection="column" padding={2}>
      <text bold color="green">Test: ghostty imported but NOT rendered</text>
      <box height={1} />
      <text color="yellow">If this shows, the import/extend is fine but rendering is broken.</text>
      <box height={1} />
      <text color="gray">Ctrl+C to exit</text>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);
