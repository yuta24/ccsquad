import { createCliRenderer } from "@opentui/core";
import { createRoot, extend } from "@opentui/react";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";

extend({ "ghostty-terminal": GhosttyTerminalRenderable });

// Test: ghostty-terminal as the ONLY element, with explicit fixed size
function App() {
  return (
    <ghostty-terminal
      ansi={"Hello from ghostty!\r\nLine 2\r\nLine 3"}
      cols={40}
      rows={5}
      width={40}
      height={5}
    />
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);
