// Test: Does importing ghostty-opentui hang?

console.error("STEP 1: before import ghostty-opentui");

try {
  const ffi = await import("ghostty-opentui");
  console.error("STEP 2: ghostty-opentui imported OK, keys:", Object.keys(ffi));
} catch (e: any) {
  console.error("STEP 2: ghostty-opentui import FAILED:", e.message);
}

console.error("STEP 3: before import ghostty-opentui/terminal-buffer");

try {
  const tb = await import("ghostty-opentui/terminal-buffer");
  console.error("STEP 4: terminal-buffer imported OK, keys:", Object.keys(tb));
} catch (e: any) {
  console.error("STEP 4: terminal-buffer import FAILED:", e.message);
}

console.error("STEP 5: before import @opentui/core");

const { createCliRenderer } = await import("@opentui/core");

console.error("STEP 6: @opentui/core imported OK");

const { createRoot } = await import("@opentui/react");

console.error("STEP 7: all imports done, creating renderer");

const renderer = await createCliRenderer({ exitOnCtrlC: true });

console.error("STEP 8: renderer created");

function App() {
  return (
    <box width="100%" height="100%" padding={2}>
      <text color="green">Reached render!</text>
    </box>
  );
}

createRoot(renderer).render(<App />);
console.error("STEP 9: render called");
