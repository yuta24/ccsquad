import { spawn, type IPty } from "bun-pty";
import { parseStreamJsonResult, formatStreamEvent, parseAnsiToSpans } from "./stream-parser.js";
import type { DisplayLine } from "./stream-parser.js";

export interface AgentExitInfo {
  exitCode: number;
  sessionId?: string;
  content: string;
  rawOutput: string;
}

export interface AgentProcess {
  /** Raw display lines (parsed from stream-json events) */
  onDisplayLines(handler: (lines: DisplayLine[]) => void): void;
  /** Called when the agent process exits */
  onExit(handler: (info: AgentExitInfo) => void): void;
  /** Kill the agent process */
  kill(): void;
  /** Whether the process has exited */
  readonly exited: boolean;
}

export interface SpawnOptions {
  args: string[];
  cols: number;
  env: Record<string, string>;
  cwd: string;
}

export function spawnAgent(options: SpawnOptions): AgentProcess {
  const { args, cols, env, cwd } = options;

  let rawOutput = "";
  let lineBuffer = "";
  let displayLines: DisplayLine[] = [];
  let exited = false;

  let displayHandler: ((lines: DisplayLine[]) => void) | null = null;
  let exitHandler: ((info: AgentExitInfo) => void) | null = null;

  const pty: IPty = spawn(args[0], args.slice(1), {
    name: "xterm-256color",
    cols: Math.max(cols, 80),
    rows: 24,
    env: { ...process.env, ...env, TERM: "xterm-256color" },
    cwd,
  });

  pty.onData((data: string) => {
    rawOutput += data;
    lineBuffer += data;

    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    const newLines: DisplayLine[] = [];
    for (const line of lines) {
      const formatted = formatStreamEvent(line.replace(/\r$/, ""));
      for (const textLine of formatted) {
        const parsed = parseAnsiToSpans(textLine);
        displayLines.push(parsed);
        newLines.push(parsed);
      }
    }

    if (newLines.length > 0 && displayHandler) {
      displayHandler(newLines);
    }
  });

  pty.onExit((exitInfo: { exitCode: number }) => {
    exited = true;

    let sessionId: string | undefined;
    let content = "";

    try {
      const result = parseStreamJsonResult(rawOutput);
      if (result) {
        sessionId = result.sessionId || undefined;
        content = result.content || "";
      }
    } catch {
      content = "";
    }

    if (exitHandler) {
      exitHandler({
        exitCode: exitInfo.exitCode,
        sessionId,
        content,
        rawOutput,
      });
    }
  });

  return {
    onDisplayLines(handler) {
      displayHandler = handler;
    },
    onExit(handler) {
      exitHandler = handler;
    },
    kill() {
      if (!exited) {
        try { pty.kill(); } catch { /* ignore */ }
      }
    },
    get exited() {
      return exited;
    },
  };
}
