// Test: No console.error before createCliRenderer
// Use file writes for debugging instead

import { writeFileSync, appendFileSync } from "fs";

const logFile = "/tmp/ccsquad-debug.log";
writeFileSync(logFile, "");

function log(msg: string) {
  appendFileSync(logFile, msg + "\n");
}

log("STEP 1: importing");

import { createCliRenderer } from "@opentui/core";
import { createRoot, extend } from "@opentui/react";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";

log("STEP 2: imports done, creating renderer");

const renderer = await createCliRenderer({ exitOnCtrlC: true });

log("STEP 3: renderer created, extending");

extend({ "ghostty-terminal": GhosttyTerminalRenderable });

log("STEP 4: rendering");

function App() {
  return (
    <box width="100%" height="100%" flexDirection="column" padding={2}>
      <text bold color="green">Working with ghostty-terminal!</text>
      <box height={1} />
      <ghostty-terminal
        ansi={"\x1b[32mHello from ghostty!\x1b[0m\r\n\x1b[33mYellow line\x1b[0m"}
        cols={40}
        rows={4}
        width={42}
        height={6}
      />
      <box height={1} />
      <text color="gray">Ctrl+C to exit</text>
    </box>
  );
}

createRoot(renderer).render(<App />);
log("STEP 5: render called");
