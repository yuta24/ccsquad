import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { spawn, type IPty } from "bun-pty";
import { PersistentTerminal } from "ghostty-opentui";
import { useRef, useEffect } from "react";
import type { WorkflowConfig } from "../../domain/types.js";
import { buildPlanCreateSystemPrompt } from "../../app/prompt-builder.js";
import { OutputLine } from "../components/output-line.js";
import type { DisplayLine } from "../../infra/stream-parser.js";
import { StatusBar } from "../components/status-bar.js";
import {
  ATTR_BOLD, COLOR_WHITE, COLOR_CYAN, COLOR_GRAY, COLOR_HEADER_BG,
} from "../constants.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { useSyncedState } from "../hooks/use-synced-state.js";

const STYLE_FLAG_BOLD = 1;
const STYLE_FLAG_FAINT = 32;

function terminalDataToDisplayLines(terminal: PersistentTerminal): DisplayLine[] {
  const data = terminal.getJson();
  const lines: DisplayLine[] = [];

  for (const line of data.lines) {
    const spans: { text: string; color: string; attrs: number }[] = [];
    for (const span of line.spans) {
      let color = span.fg ?? COLOR_WHITE;
      let attrs = 0;
      if (span.flags & STYLE_FLAG_BOLD) attrs |= ATTR_BOLD;
      if (span.flags & STYLE_FLAG_FAINT) color = COLOR_GRAY;
      spans.push({ text: span.text, color, attrs });
    }
    lines.push(spans);
  }

  return lines;
}

interface PlanCreateViewProps {
  projectRoot: string;
  workflows: Record<string, WorkflowConfig>;
  onDone: () => void;
}

export function PlanCreateView({ projectRoot, workflows, onDone }: PlanCreateViewProps) {
  const { cols, rows } = useTerminalSize();
  const ptyRef = useRef<IPty | null>(null);
  const terminalRef = useRef<PersistentTerminal | null>(null);
  const [displayLines, setDisplayLines, displayLinesRef] = useSyncedState<DisplayLine[]>([]);
  const [exited, _setExited, exitedRef] = useSyncedState(false);

  const termCols = Math.max(cols, 80);
  const termRows = Math.max(rows - 2, 24);

  useEffect(() => {
    const terminal = new PersistentTerminal({ cols: termCols, rows: termRows });
    terminalRef.current = terminal;

    const workflowNames = Object.keys(workflows);
    const systemPrompt = buildPlanCreateSystemPrompt(workflowNames);
    const args = ["claude", "--append-system-prompt", systemPrompt];

    const pty = spawn(args[0], args.slice(1), {
      name: "xterm-256color",
      cols: termCols,
      rows: termRows,
      env: { ...process.env, TERM: "xterm-256color", CCSQUAD_ROOT: projectRoot },
      cwd: process.cwd(),
    });
    ptyRef.current = pty;

    pty.onData((_data: string) => {
      terminal.feed(_data);
      const lines = terminalDataToDisplayLines(terminal);
      setDisplayLines(lines);
    });

    pty.onExit(() => {
      exitedRef.current = true;
      const lines = terminalDataToDisplayLines(terminal);
      setDisplayLines(lines);
    });

    return () => {
      if (ptyRef.current) {
        try { ptyRef.current.kill(); } catch { /* ignore */ }
        ptyRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (ptyRef.current && !exitedRef.current) {
      try { ptyRef.current.resize(termCols, termRows); } catch { /* ignore */ }
    }
    if (terminalRef.current) {
      try { terminalRef.current.resize(termCols, termRows); } catch { /* ignore */ }
    }
  }, [cols, rows]);

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

  return (
    <box width="100%" height="100%" flexDirection="column">
      <box width="100%" height={1} backgroundColor={COLOR_HEADER_BG}>
        <text fg={COLOR_CYAN} attributes={ATTR_BOLD}> CCSQUAD - プラン作成 </text>
      </box>

      <scrollbox
        flexGrow={1}
        scrollY
        stickyScroll
        stickyStart="bottom"
        focused
      >
        {displayLines.map((line, i) => (
          <OutputLine key={i} spans={line} />
        ))}
      </scrollbox>

      <StatusBar items={
        exitedRef.current
          ? [{ key: "Enter/Esc", label: "戻る" }]
          : [{ key: "対話中", label: "Claude とプランを作成" }]
      } />
    </box>
  );
}
