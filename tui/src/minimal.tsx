import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

function App() {
  return (
    <box width="100%" height="100%" flexDirection="column" padding={2}>
      <text bold color="green">
        ccsquad-tui minimal test
      </text>
      <text color="white">
        If you can see this, OpenTUI is working.
      </text>
      <text color="gray">
        Press Ctrl+C to exit.
      </text>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);
