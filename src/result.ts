export interface AgentResult {
  job_id: string;
  result: string;
  message: string;
}

export interface PrintResult {
  sessionId: string;
  content: string;
  costUsd: number;
}

/**
 * Parse the JSON output from `claude --print --output-format json`.
 * Expected shape: { session_id: string, result: string, cost_usd: number, ... }
 */
export function parsePrintOutput(json: string): PrintResult {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return {
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : "",
    content: typeof parsed.result === "string" ? parsed.result : "",
    costUsd: typeof parsed.cost_usd === "number" ? parsed.cost_usd : 0,
  };
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
