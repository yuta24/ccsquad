import type { KeyEvent, OptimizedBuffer } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { PersistentTerminal } from "ghostty-opentui";
import { spawn, type IPty } from "bun-pty";
import { useState, useRef, useEffect, useCallback } from "react";
import { renderTerminalToBuffer } from "../terminal-render.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";

interface NormalModeProps {
  onSwitchToWorkflow: () => void;
  onQuit: () => void;
}

export function NormalMode({ onSwitchToWorkflow, onQuit }: NormalModeProps) {
  const [_, setTick] = useState(0);
  const ptyRef = useRef<IPty | null>(null);
  const termRef = useRef<PersistentTerminal | null>(null);
  const { cols, rows } = useTerminalSize();

  useEffect(() => {
    const term = new PersistentTerminal({ cols, rows });
    termRef.current = term;

    const pty = spawn("claude", [], {
      name: "xterm-256color",
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
      ptyRef.current = null;
      termRef.current = null;
    };
  }, []);

  // Handle terminal resize
  useEffect(() => {
    if (ptyRef.current) {
      try { ptyRef.current.resize(cols, rows); } catch { /* ignore */ }
    }
    if (termRef.current) {
      try { (termRef.current as any).resize?.(cols, rows); } catch { /* ignore */ }
    }
  }, [cols, rows]);

  useKeyboard((event: KeyEvent) => {
    if (event.ctrl && event.name === "q") {
      ptyRef.current?.kill();
      termRef.current?.destroy();
      onQuit();
      event.preventDefault();
      return;
    }

    if (event.ctrl && event.name === "s") {
      ptyRef.current?.kill();
      termRef.current?.destroy();
      onSwitchToWorkflow();
      event.preventDefault();
      return;
    }

    // Forward to PTY
    if (ptyRef.current) {
      if (event.sequence) {
        ptyRef.current.write(event.sequence);
      } else if (event.name && event.name.length === 1) {
        ptyRef.current.write(event.name);
      }
    }
    event.preventDefault();
  });

  const renderTerminal = useCallback((buffer: OptimizedBuffer) => {
    const term = termRef.current;
    if (!term) return;
    try {
      const data = term.getJson();
      renderTerminalToBuffer(buffer, data, 1, 1);
    } catch {
      // terminal might be destroyed
    }
  }, []);

  return (
    <box
      width="100%"
      height="100%"
      borderStyle="single"
      borderColor="#66ff66"
      title=" SQUAD | Ctrl+S: Workflow  Ctrl+Q: Quit "
      titleColor="cyan"
      renderAfter={renderTerminal}
    />
  );
}
