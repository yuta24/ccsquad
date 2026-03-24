import { createCliRenderer } from "@opentui/core";
import { createRoot, extend, useRenderer } from "@opentui/react";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";
import { useEffect, useRef } from "react";

// Don't use extend — manually add the renderable

function App() {
  const renderer = useRenderer();
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;

    try {
      const term = new GhosttyTerminalRenderable(renderer, {
        ansi: "\x1b[32mHello from ghostty!\x1b[0m\r\nLine 2\r\nLine 3",
        cols: 40,
        rows: 5,
        width: 42,
        height: 7,
      });
      console.error("GhosttyTerminalRenderable created successfully");
    } catch (e) {
      console.error("Failed to create GhosttyTerminalRenderable:", e);
    }
  }, []);

  return (
    <box width="100%" height="100%" flexDirection="column" padding={2}>
      <text bold color="green">Step 2c: Debugging ghostty-terminal</text>
      <text color="white">Check stderr for debug output.</text>
      <text color="gray">Ctrl+C to exit.</text>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);
