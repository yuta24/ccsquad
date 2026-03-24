import { createCliRenderer } from "@opentui/core";
import { createRoot, extend } from "@opentui/react";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";

extend({ "ghostty-terminal": GhosttyTerminalRenderable });

function App() {
  // Static ANSI content to test ghostty-terminal rendering
  const ansi = [
    "\x1b[32mHello from ghostty-terminal!\x1b[0m",
    "\x1b[33mThis is yellow text.\x1b[0m",
    "\x1b[1;36mBold cyan text.\x1b[0m",
    "",
    "If you see colored text, ghostty-terminal works.",
  ].join("\r\n");

  return (
    <box width="100%" height="100%" flexDirection="row">
      <box
        width={30}
        height="100%"
        flexDirection="column"
        borderStyle="single"
        borderColor="green"
        padding={1}
      >
        <text bold color="white">Sidebar</text>
        <text color="gray">Ctrl+C to exit</text>
      </box>
      <box
        flexGrow={1}
        height="100%"
        borderStyle="single"
        borderColor="cyan"
      >
        <ghostty-terminal ansi={ansi} cols={80} rows={24} />
      </box>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);
