import { createCliRenderer, type KeyEvent, RGBA, type OptimizedBuffer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { PersistentTerminal, type TerminalData, StyleFlags } from "ghostty-opentui";
import { spawn, type IPty } from "bun-pty";
import { useState, useRef, useEffect } from "react";

// --- RGBA cache for performance ---
const rgbaCache = new Map<number, RGBA>();

function getCachedRGBA(r: number, g: number, b: number): RGBA {
  const key = (r << 16) | (g << 8) | b;
  let cached = rgbaCache.get(key);
  if (!cached) {
    cached = RGBA.fromInts(r, g, b);
    rgbaCache.set(key, cached);
  }
  return cached;
}

function hexToRGBA(hex: string): RGBA {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return getCachedRGBA(r, g, b);
}

const DEFAULT_FG = getCachedRGBA(212, 212, 212); // #d4d4d4
const DEFAULT_BG = getCachedRGBA(30, 30, 30);    // #1e1e1e
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

// Attribute flags matching OpenTUI
const ATTR_BOLD = 1;
const ATTR_ITALIC = 4;
const ATTR_UNDERLINE = 8;
const ATTR_STRIKETHROUGH = 128;

// --- Render terminal data to OptimizedBuffer ---
function renderTerminalToBuffer(
  buffer: OptimizedBuffer,
  data: TerminalData,
  offsetX: number,
  offsetY: number,
) {
  for (let row = 0; row < data.lines.length; row++) {
    const line = data.lines[row];
    let col = 0;

    for (const span of line.spans) {
      let fg = span.fg ? hexToRGBA(span.fg) : DEFAULT_FG;
      let bg = span.bg ? hexToRGBA(span.bg) : TRANSPARENT;
      const flags = span.flags;

      // Handle inverse
      if (flags & StyleFlags.INVERSE) {
        const tmp = fg;
        fg = bg.buffer[3] === 0 ? DEFAULT_BG : bg; // if transparent bg, use default
        bg = tmp;
      }

      // Handle dim/faint
      if (flags & StyleFlags.FAINT) {
        const r = Math.floor(fg.buffer[0] * 255 * 0.5);
        const g = Math.floor(fg.buffer[1] * 255 * 0.5);
        const b = Math.floor(fg.buffer[2] * 255 * 0.5);
        fg = getCachedRGBA(r, g, b);
      }

      // Build attributes
      let attrs = 0;
      if (flags & StyleFlags.BOLD) attrs |= ATTR_BOLD;
      if (flags & StyleFlags.ITALIC) attrs |= ATTR_ITALIC;
      if (flags & StyleFlags.UNDERLINE) attrs |= ATTR_UNDERLINE;
      if (flags & StyleFlags.STRIKETHROUGH) attrs |= ATTR_STRIKETHROUGH;

      // Render each character
      for (const char of span.text) {
        buffer.setCell(offsetX + col, offsetY + row, char, fg, bg, attrs);
        col++;
      }
    }
  }

  // Render cursor
  if (data.cursorVisible) {
    const cx = data.cursor[0];
    const cy = Math.max(0, (data.totalLines - data.rows) + data.cursor[1] - data.offset);
    if (cy >= 0 && cy < data.lines.length) {
      // Invert colors at cursor position for block cursor
      buffer.setCell(
        offsetX + cx,
        offsetY + cy,
        " ",
        DEFAULT_BG,
        DEFAULT_FG,
        0,
      );
    }
  }
}

// --- Components ---

function Sidebar({ focused }: { focused: boolean }) {
  return (
    <box
      width={30}
      height="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? "green" : "gray"}
      padding={1}
    >
      <text bold color="white">ccsquad-tui PoC</text>
      <text color="gray">{"─".repeat(24)}</text>
      <box height={1} />
      <text color="cyan">Job: J000001</text>
      <text color="cyan">Workflow: dev</text>
      <text color="cyan">Phase: code</text>
      <text color="green">Status: Running</text>

      <box height={1} />
      <text color="gray">{"─".repeat(24)}</text>
      <text bold color="white">Phase History</text>
      <text color="green">  done  plan</text>
      <text color="yellow">  now   code</text>
      <text color="gray">  next  review</text>

      <box flexGrow={1} />
      <text color="gray">{"─".repeat(24)}</text>
      <text color="gray">[Tab] switch focus</text>
      <text color="gray">[a]   approve</text>
      <text color="gray">[r]   reject</text>
      <text color="gray">[q]   quit</text>
      {focused && <text color="green" bold>● Sidebar</text>}
    </box>
  );
}

// --- Main App ---

let rendererInstance: any = null;

function quit() {
  rendererInstance?.destroy();
  process.exit(0);
}

function App() {
  const [focus, setFocus] = useState<"sidebar" | "terminal">("terminal");
  const [_, setTick] = useState(0); // force re-render on terminal update
  const ptyRef = useRef<IPty | null>(null);
  const termRef = useRef<PersistentTerminal | null>(null);
  const focusRef = useRef(focus);

  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);

  useEffect(() => {
    const cols = 80;
    const rows = 24;
    const term = new PersistentTerminal({ cols, rows });
    termRef.current = term;

    const pty = spawn("claude", [], {
      cols,
      rows,
      env: { ...process.env, TERM: "xterm-256color" },
      cwd: process.cwd(),
    });
    ptyRef.current = pty;

    pty.onData((data: string) => {
      term.feed(data);
      setTick((t) => t + 1);
    });

    pty.onExit(() => {
      setTick((t) => t + 1);
    });

    return () => {
      pty.kill();
      term.destroy();
    };
  }, []);

  useKeyboard((event: KeyEvent) => {
    const currentFocus = focusRef.current;

    if (event.name === "tab") {
      setFocus((prev) => {
        const next = prev === "sidebar" ? "terminal" : "sidebar";
        focusRef.current = next;
        return next;
      });
      event.preventDefault();
      return;
    }

    if (currentFocus === "sidebar") {
      if (event.name === "q") {
        ptyRef.current?.kill();
        termRef.current?.destroy();
        quit();
      }
      event.preventDefault();
      return;
    }

    if (currentFocus === "terminal" && ptyRef.current) {
      if (event.sequence) {
        ptyRef.current.write(event.sequence);
      } else if (event.name && event.name.length === 1) {
        ptyRef.current.write(event.name);
      }
      event.preventDefault();
    }
  });

  // renderAfter callback: draw terminal cells with colors
  const renderTerminal = (buffer: OptimizedBuffer) => {
    const term = termRef.current;
    if (!term) return;

    try {
      const data = term.getJson();
      // offset by 1 for the border
      renderTerminalToBuffer(buffer, data, 32, 1);
    } catch {
      // terminal might be destroyed
    }
  };

  return (
    <box width="100%" height="100%" flexDirection="row">
      <Sidebar focused={focus === "sidebar"} />
      <box
        flexGrow={1}
        height="100%"
        borderStyle="single"
        borderColor={focus === "terminal" ? "green" : "gray"}
        renderAfter={renderTerminal}
      />
    </box>
  );
}

rendererInstance = await createCliRenderer({ exitOnCtrlC: false });
createRoot(rendererInstance).render(<App />);
