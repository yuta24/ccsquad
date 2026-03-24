import { createCliRenderer, type KeyEvent } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { PersistentTerminal } from "ghostty-opentui";
import { spawn, type IPty } from "bun-pty";
import { useState, useRef, useEffect, useCallback } from "react";

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
      <box flexGrow={1} />
      <text color="gray">{"─".repeat(24)}</text>
      <text color="gray">[Tab] switch focus</text>
      <text color="gray">[q]   quit (sidebar)</text>
      {focused && <text color="green" bold>● Sidebar</text>}
    </box>
  );
}

function TerminalPanel({
  focused,
  lines,
}: {
  focused: boolean;
  lines: string[];
}) {
  return (
    <box
      flexGrow={1}
      height="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? "green" : "gray"}
      overflow="hidden"
    >
      {lines.map((line, i) => (
        <text key={i} color="white">
          {line || " "}
        </text>
      ))}
      {focused && (
        <text color="green" bold>● Terminal</text>
      )}
    </box>
  );
}

function App() {
  const [focus, setFocus] = useState<"sidebar" | "terminal">("terminal");
  const [lines, setLines] = useState<string[]>(["Starting bash..."]);
  const ptyRef = useRef<IPty | null>(null);
  const termRef = useRef<PersistentTerminal | null>(null);
  const focusRef = useRef(focus);

  // Keep ref in sync with state
  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);

  useEffect(() => {
    const term = new PersistentTerminal({ cols: 80, rows: 24 });
    termRef.current = term;

    const pty = spawn("bash", ["--login"], {
      cols: 80,
      rows: 24,
      env: { ...process.env, TERM: "xterm-256color" },
      cwd: process.cwd(),
    });
    ptyRef.current = pty;

    pty.onData((data: string) => {
      term.feed(data);
      const text = term.getText();
      const newLines = text.split("\n").slice(0, 24);
      setLines(newLines);
    });

    pty.onExit(() => {
      setLines((prev) => [...prev, "[Process exited]"]);
    });

    return () => {
      pty.kill();
      term.destroy();
    };
  }, []);

  useKeyboard((event: KeyEvent) => {
    const currentFocus = focusRef.current;

    // Tab switches focus
    if (event.name === "tab") {
      setFocus((prev) => {
        const next = prev === "sidebar" ? "terminal" : "sidebar";
        focusRef.current = next;
        return next;
      });
      event.preventDefault();
      return;
    }

    // Sidebar mode
    if (currentFocus === "sidebar") {
      if (event.name === "q") {
        ptyRef.current?.kill();
        process.exit(0);
      }
      event.preventDefault();
      return;
    }

    // Terminal mode: forward raw sequence to PTY
    if (currentFocus === "terminal" && ptyRef.current) {
      const pty = ptyRef.current;

      // Use event.sequence which contains the raw bytes
      if (event.sequence) {
        pty.write(event.sequence);
      } else if (event.name && event.name.length === 1) {
        pty.write(event.name);
      }
      event.preventDefault();
    }
  });

  return (
    <box width="100%" height="100%" flexDirection="row">
      <Sidebar focused={focus === "sidebar"} />
      <TerminalPanel focused={focus === "terminal"} lines={lines} />
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<App />);
