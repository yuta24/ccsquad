// ── Types ──

export interface TextSpan {
  text: string;
  color: string;
  attrs: number;
}

export type DisplayLine = TextSpan[];

export interface PrintResult {
  sessionId: string;
  content: string;
  costUsd: number;
}

export interface AgentResult {
  job_id: string;
  result: string;
  message: string;
}

// ── Constants ──

const COLOR_WHITE = "#ffffff";
const COLOR_DIM = "#6a6a6a";
const COLOR_RED = "#ff5555";
const COLOR_GREEN = "#50fa7b";
const COLOR_CYAN = "#8be9fd";
const ATTR_BOLD = 1;

const ESC_RESET = "\x1b[0m";
const ESC_DIM = "\x1b[2m";
const ESC_BOLD = "\x1b[1m";
const ESC_CYAN = "\x1b[36m";
const ESC_GREEN = "\x1b[32m";
const ESC_RED = "\x1b[31m";

// ── ANSI → DisplayLine parser ──

export function parseAnsiToSpans(text: string): DisplayLine {
  const spans: TextSpan[] = [];
  let color = COLOR_WHITE;
  let attrs = 0;
  let buf = "";

  const flush = () => {
    if (buf) {
      spans.push({ text: buf, color, attrs });
      buf = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      flush();
      const end = text.indexOf("m", i + 2);
      if (end === -1) { i++; continue; }
      const codes = text.slice(i + 2, end).split(";").map(Number);
      for (const code of codes) {
        switch (code) {
          case 0: color = COLOR_WHITE; attrs = 0; break;
          case 1: attrs |= ATTR_BOLD; break;
          case 2: color = COLOR_DIM; break;
          case 31: color = COLOR_RED; break;
          case 32: color = COLOR_GREEN; break;
          case 36: color = COLOR_CYAN; break;
        }
      }
      i = end + 1;
    } else {
      buf += text[i];
      i++;
    }
  }
  flush();
  return spans;
}

// ── stream-json event formatter ──

export function formatStreamEvent(line: string): string[] {
  if (!line.startsWith("{")) return [];
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }

  const type = event.type as string | undefined;
  if (type === "system" || type === "rate_limit_event" || type === "result") {
    return [];
  }

  if (type === "assistant") {
    const msg = event.message as Record<string, unknown> | undefined;
    const content = (msg?.content as Array<Record<string, unknown>>) ?? [];
    const result: string[] = [];
    for (const block of content) {
      const bt = block.type as string;
      if (bt === "thinking") {
        const t = (block.thinking as string) ?? "";
        if (t) for (const l of t.split("\n")) result.push(`${ESC_DIM}${l}${ESC_RESET}`);
      } else if (bt === "text") {
        const t = (block.text as string) ?? "";
        if (t) for (const l of t.split("\n")) result.push(l);
      } else if (bt === "tool_use") {
        const name = (block.name as string) ?? "?";
        const input = block.input as Record<string, unknown> | undefined;
        const keys = input ? Object.keys(input).join(", ") : "";
        result.push(`${ESC_BOLD}${ESC_CYAN}▶ ${name}${ESC_RESET}${ESC_DIM}(${keys})${ESC_RESET}`);
      }
    }
    return result;
  }

  if (type === "user") {
    const msg = event.message as Record<string, unknown> | undefined;
    const content = (msg?.content as Array<Record<string, unknown>>) ?? [];
    const result: string[] = [];
    for (const block of content) {
      if ((block.type as string) === "tool_result") {
        const isError = block.is_error === true;
        const raw = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        const preview = raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
        result.push(isError
          ? `${ESC_RED}✗ ${preview}${ESC_RESET}`
          : `${ESC_GREEN}✓${ESC_RESET} ${ESC_DIM}${preview}${ESC_RESET}`);
      }
    }
    return result;
  }

  return [];
}

// ── ANSI strip ──

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

// ── Result parsers ──

export function parseStreamJsonResult(rawOutput: string): PrintResult | null {
  const cleaned = stripAnsi(rawOutput);
  const lines = cleaned.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === "result") {
        return {
          sessionId: typeof parsed.session_id === "string" ? parsed.session_id : "",
          content: typeof parsed.result === "string" ? parsed.result : "",
          costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0,
        };
      }
    } catch {
      // not valid JSON, continue
    }
  }
  return null;
}

export function parsePrintOutput(json: string): PrintResult {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return {
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : "",
    content: typeof parsed.result === "string" ? parsed.result : "",
    costUsd: typeof parsed.cost_usd === "number" ? parsed.cost_usd : 0,
  };
}

export function parsePrintOutputFromText(text: string): PrintResult | null {
  const cleaned = stripAnsi(text);
  const lines = cleaned.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if ("session_id" in parsed || "result" in parsed) {
        return {
          sessionId: typeof parsed.session_id === "string" ? parsed.session_id : "",
          content: typeof parsed.result === "string" ? parsed.result : "",
          costUsd: typeof parsed.cost_usd === "number" ? parsed.cost_usd : 0,
        };
      }
    } catch {
      // not valid JSON, continue
    }
  }
  return null;
}

export function extractResult(message: string): AgentResult | null {
  const lines = message.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("{") && trimmed.includes('"result"')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof parsed.job_id === "string") {
          return {
            job_id: parsed.job_id,
            result: typeof parsed.result === "string" ? parsed.result : "",
            message: typeof parsed.message === "string" ? parsed.message : "",
          };
        }
      } catch {
        // not valid JSON, continue
      }
    }
  }
  return null;
}
