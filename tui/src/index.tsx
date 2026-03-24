import { createCliRenderer } from "@opentui/core";
import { createRoot, extend, useKeyboard } from "@opentui/react";
import { useState, useRef, useEffect, useCallback } from "react";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";
import { spawn, type IPty } from "bun-pty";

// Register ghostty-terminal as a custom OpenTUI element
extend({ "ghostty-terminal": GhosttyTerminalRenderable });

// --- Sidebar Component ---
function Sidebar({ focused }: { focused: boolean }) {
  return (
    <box
      width={32}
      height="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? "green" : "gray"}
      padding={1}
    >
      <text bold color="white">
        ccsquad-tui PoC
      </text>
      <text color="gray">{"─".repeat(26)}</text>

      <box height={1} />
      <text color="cyan">Job: J000001</text>
      <text color="cyan">Workflow: dev</text>
      <text color="cyan">Phase: code</text>
      <text color="green">Status: Running</text>

      <box height={1} />
      <text color="gray">{"─".repeat(26)}</text>
      <text bold color="white">
        Phase History
      </text>
      <text color="green">  done  plan</text>
      <text color="yellow">  now   code</text>
      <text color="gray">  next  review</text>

      <box flexGrow={1} />
      <text color="gray">{"─".repeat(26)}</text>
      <text bold color="white">
        Keys
      </text>
      <text color="gray">  [Tab] switch focus</text>
      <text color="gray">  [a]   approve</text>
      <text color="gray">  [r]   reject</text>
      <text color="gray">  [q]   quit</text>

      {focused && (
        <>
          <box height={1} />
          <text color="green" bold>
            Sidebar focused
          </text>
        </>
      )}
    </box>
  );
}

// --- Terminal Panel Component ---
function TerminalPanel({
  focused,
  terminalRef,
}: {
  focused: boolean;
  terminalRef: React.RefObject<any>;
}) {
  return (
    <box
      flexGrow={1}
      height="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? "green" : "gray"}
    >
      <ghostty-terminal
        ref={terminalRef}
        persistent={true}
        showCursor={true}
        cols={80}
        rows={24}
      />
    </box>
  );
}

// --- Main App ---
function App() {
  const [focus, setFocus] = useState<"sidebar" | "terminal">("terminal");
  const ptyRef = useRef<IPty | null>(null);
  const terminalRef = useRef<any>(null);

  // Spawn PTY with bash (replace with `claude` for real use)
  useEffect(() => {
    const pty = spawn("bash", ["--login"], {
      cols: 80,
      rows: 24,
      env: { ...process.env, TERM: "xterm-256color" },
      cwd: process.cwd(),
    });

    ptyRef.current = pty;

    pty.onData((data: string) => {
      if (terminalRef.current?.feed) {
        terminalRef.current.feed(data);
      }
    });

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      if (terminalRef.current?.feed) {
        terminalRef.current.feed(
          `\r\n[Process exited with code ${exitCode}]\r\n`
        );
      }
    });

    return () => {
      pty.kill();
    };
  }, []);

  // Global keyboard handler
  useKeyboard(
    useCallback(
      (event: any) => {
        // Tab switches focus
        if (event.key === "Tab") {
          setFocus((prev) => (prev === "sidebar" ? "terminal" : "sidebar"));
          return true;
        }

        // Sidebar mode
        if (focus === "sidebar") {
          if (event.ctrl && event.key === "c") {
            ptyRef.current?.kill();
            process.exit(0);
          }
          switch (event.key) {
            case "q":
              ptyRef.current?.kill();
              process.exit(0);
              return true;
            case "a":
              // TODO: ccsquad job approve
              return true;
            case "r":
              // TODO: ccsquad job reject
              return true;
          }
          return true;
        }

        // Terminal mode: forward input to PTY
        if (focus === "terminal" && ptyRef.current) {
          const pty = ptyRef.current;

          if (event.ctrl && event.key) {
            const code = event.key.toLowerCase().charCodeAt(0) - 96;
            if (code > 0 && code < 27) {
              pty.write(String.fromCharCode(code));
            }
          } else if (
            event.key === "Return" ||
            event.key === "Enter"
          ) {
            pty.write("\r");
          } else if (event.key === "Backspace") {
            pty.write("\x7f");
          } else if (event.key === "Escape") {
            pty.write("\x1b");
          } else if (event.key === "Up") {
            pty.write("\x1b[A");
          } else if (event.key === "Down") {
            pty.write("\x1b[B");
          } else if (event.key === "Right") {
            pty.write("\x1b[C");
          } else if (event.key === "Left") {
            pty.write("\x1b[D");
          } else if (event.key === "Space") {
            pty.write(" ");
          } else if (event.key && event.key.length === 1) {
            pty.write(event.key);
          }
          return true;
        }

        return false;
      },
      [focus]
    )
  );

  return (
    <box width="100%" height="100%" flexDirection="row">
      <Sidebar focused={focus === "sidebar"} />
      <TerminalPanel focused={focus === "terminal"} terminalRef={terminalRef} />
    </box>
  );
}

// Bootstrap
const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<App />);
