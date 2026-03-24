import { createCliRenderer, type KeyEvent } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { PersistentTerminal } from "ghostty-opentui";
import { spawn, type IPty } from "bun-pty";
import { useState, useRef, useEffect } from "react";

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
    </box>
  );
}

let rendererInstance: any = null;

function quit() {
  rendererInstance?.destroy();
  process.exit(0);
}

function App() {
  const [focus, setFocus] = useState<"sidebar" | "terminal">("terminal");
  const [lines, setLines] = useState<string[]>(["Starting claude..."]);
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

    // Launch claude instead of bash
    const pty = spawn("claude", [], {
      cols,
      rows,
      env: { ...process.env, TERM: "xterm-256color" },
      cwd: process.cwd(),
    });
    ptyRef.current = pty;

    pty.onData((data: string) => {
      term.feed(data);
      const text = term.getText();
      const newLines = text.split("\n").slice(0, rows);
      setLines(newLines);
    });

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      setLines((prev) => [...prev, `[claude exited with code ${exitCode}]`]);
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

  return (
    <box width="100%" height="100%" flexDirection="row">
      <Sidebar focused={focus === "sidebar"} />
      <TerminalPanel focused={focus === "terminal"} lines={lines} />
    </box>
  );
}

rendererInstance = await createCliRenderer({ exitOnCtrlC: false });
createRoot(rendererInstance).render(<App />);
