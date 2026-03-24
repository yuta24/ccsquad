import { createCliRenderer } from "@opentui/core";
import { createRoot, extend } from "@opentui/react";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";
import { ptyToJson } from "ghostty-opentui";
import { writeFileSync } from "fs";

extend({ "ghostty-terminal": GhosttyTerminalRenderable });

// Test: Use ptyToJson directly and render as plain text
const ansi = "\x1b[32mHello!\x1b[0m\r\n\x1b[33mYellow\x1b[0m\r\nPlain text";
const data = ptyToJson(ansi, { cols: 40, rows: 5 });

// Dump parsed data to a file for inspection
writeFileSync("/tmp/ghostty-parse.json", JSON.stringify(data, null, 2));

// Render parsed text manually without ghostty-terminal
const lines = data.lines.map((line) =>
  line.spans.map((s) => s.text).join("")
);

function App() {
  return (
    <box width="100%" height="100%" flexDirection="column" padding={2}>
      <text bold color="green">ptyToJson output (manual render):</text>
      <box height={1} />
      {lines.map((line, i) => (
        <text key={i} color="white">{line || " "}</text>
      ))}
      <box height={1} />
      <text color="gray">Check /tmp/ghostty-parse.json for raw data</text>
      <text color="gray">Ctrl+C to exit</text>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);
