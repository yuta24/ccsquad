import { createCliRenderer } from "@opentui/core";
import { createRoot, extend } from "@opentui/react";

// Test 1: Can we import GhosttyTerminalRenderable?
let importOk = false;
let importError = "";
let GhosttyTerminalRenderable: any;

try {
  const mod = await import("ghostty-opentui/terminal-buffer");
  GhosttyTerminalRenderable = mod.GhosttyTerminalRenderable;
  importOk = true;
} catch (e: any) {
  importError = e.message;
}

// Test 2: Can we import ptyToJson from the base module?
let ffiOk = false;
let ffiError = "";
try {
  const ffi = await import("ghostty-opentui");
  const result = ffi.ptyToJson("\x1b[32mtest\x1b[0m", { cols: 20, rows: 2 });
  ffiOk = result.lines.length > 0;
} catch (e: any) {
  ffiError = e.message;
}

// Test 3: Does extend work?
let extendOk = false;
let extendError = "";
if (GhosttyTerminalRenderable) {
  try {
    extend({ "ghostty-terminal": GhosttyTerminalRenderable });
    extendOk = true;
  } catch (e: any) {
    extendError = e.message;
  }
}

function App() {
  return (
    <box width="100%" height="100%" flexDirection="column" padding={2}>
      <text bold color="white">
        Ghostty Integration Diagnostics
      </text>
      <box height={1} />
      <text color={importOk ? "green" : "red"}>
        1. Import GhosttyTerminalRenderable: {importOk ? "OK" : `FAIL: ${importError}`}
      </text>
      <text color={ffiOk ? "green" : "red"}>
        2. ptyToJson (native FFI): {ffiOk ? "OK" : `FAIL: ${ffiError}`}
      </text>
      <text color={extendOk ? "green" : "red"}>
        3. extend() registration: {extendOk ? "OK" : `FAIL: ${extendError}`}
      </text>
      <box height={1} />

      {extendOk && (
        <>
          <text color="cyan">4. Rendering ghostty-terminal below:</text>
          <box height={1} />
          <ghostty-terminal
            ansi={"\x1b[32mHello!\x1b[0m\r\n\x1b[33mYellow line\x1b[0m"}
            cols={40}
            rows={4}
            width={42}
            height={6}
          />
          <box height={1} />
          <text color="cyan">--- end of ghostty-terminal ---</text>
        </>
      )}

      <box height={1} />
      <text color="gray">Ctrl+C to exit</text>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);
