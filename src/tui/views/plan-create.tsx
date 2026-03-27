import type { KeyEvent } from "@opentui/core";
import { useKeyboard, extend } from "@opentui/react";
import { spawn, type IPty } from "bun-pty";
import { useRef, useEffect } from "react";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";
import type { SquadConfig } from "../../config.js";
import { buildPlanCreateSystemPrompt } from "../../service/prompt-builder.js";
import { StatusBar } from "../components/status-bar.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { useSyncedState } from "../hooks/use-synced-state.js";

extend({ "ghostty-terminal": GhosttyTerminalRenderable });

interface PlanCreateViewProps {
  projectRoot: string;
  config: SquadConfig;
  onDone: () => void;
}

export function PlanCreateView({ projectRoot, config, onDone }: PlanCreateViewProps) {
  const { cols, rows } = useTerminalSize();
  const ptyRef = useRef<IPty | null>(null);
  const termRef = useRef<GhosttyTerminalRenderable | null>(null);
  const [exited, setExited, exitedRef] = useSyncedState(false);

  // Spawn interactive Claude session
  useEffect(() => {
    const workflows = Object.keys(config.workflows);
    const systemPrompt = buildPlanCreateSystemPrompt(workflows);
    const args = ["claude", "--append-system-prompt", systemPrompt];

    const pty = spawn(args[0], args.slice(1), {
      name: "xterm-256color",
      cols: Math.max(cols, 80),
      rows: Math.max(rows - 1, 24),
      env: { ...process.env, TERM: "xterm-256color", CCSQUAD_ROOT: projectRoot },
      cwd: process.cwd(),
    });
    ptyRef.current = pty;

    pty.onData((data: string) => {
      termRef.current?.feed(data);
    });

    pty.onExit(() => {
      setExited(true);
    });

    return () => {
      if (ptyRef.current) {
        try { ptyRef.current.kill(); } catch { /* ignore */ }
        ptyRef.current = null;
      }
    };
  }, []);

  // Resize PTY when terminal size changes
  useEffect(() => {
    if (ptyRef.current && !exitedRef.current) {
      try {
        ptyRef.current.resize(Math.max(cols, 80), Math.max(rows - 1, 24));
      } catch { /* ignore */ }
    }
    if (termRef.current) {
      termRef.current.cols = Math.max(cols, 80);
      termRef.current.rows = Math.max(rows - 1, 24);
    }
  }, [cols, rows]);

  // Forward keyboard input to PTY
  useKeyboard((event: KeyEvent) => {
    if (exitedRef.current) {
      if (event.name === "escape" || event.name === "return" || event.name === "enter") {
        onDone();
      }
      event.preventDefault();
      return;
    }

    if (ptyRef.current) {
      ptyRef.current.write(event.sequence);
      event.preventDefault();
    }
  });

  const termRows = Math.max(rows - 1, 24);
  const termCols = Math.max(cols, 80);

  return (
    <box width="100%" height="100%" flexDirection="column">
      <box flexGrow={1}>
        <ghostty-terminal
          ref={termRef}
          persistent
          showCursor
          cursorStyle="block"
          cols={termCols}
          rows={termRows}
        />
      </box>
      <StatusBar items={
        exited
          ? [{ key: "Enter/Esc", label: "戻る" }]
          : [{ key: "対話中", label: "Claude とプランを作成" }]
      } />
    </box>
  );
}
