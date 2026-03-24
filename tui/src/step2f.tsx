// Test: Import order matters? Import opentui FIRST, ghostty AFTER

console.error("STEP 1: import @opentui/core");
const { createCliRenderer } = await import("@opentui/core");

console.error("STEP 2: import @opentui/react");
const { createRoot, extend } = await import("@opentui/react");

console.error("STEP 3: createCliRenderer");
const renderer = await createCliRenderer({ exitOnCtrlC: true });

console.error("STEP 4: renderer created OK, now import ghostty");
const { GhosttyTerminalRenderable } = await import("ghostty-opentui/terminal-buffer");

console.error("STEP 5: ghostty imported, extending");
extend({ "ghostty-terminal": GhosttyTerminalRenderable });

console.error("STEP 6: rendering");

function App() {
  return (
    <box width="100%" height="100%" flexDirection="column" padding={2}>
      <text bold color="green">Import order test</text>
      <box height={1} />
      <ghostty-terminal
        ansi={"\x1b[32mHello!\x1b[0m\r\n\x1b[33mYellow\x1b[0m"}
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
console.error("STEP 7: done");
