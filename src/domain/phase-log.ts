export function buildPhaseLogEntry(
  phase: string,
  result: string,
  next: string,
  message: string,
): string {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (message === "") {
    return `### ${phase} (${result} → ${next}) - ${timestamp}\n\n`;
  }
  return `### ${phase} (${result} → ${next}) - ${timestamp}\n${message}\n\n`;
}

export interface PhaseLogEntry {
  phase: string;
  result: string;
  next: string;
  timestamp: string;
}

const PHASE_LOG_HEADER_RE = /^###\s+(\S+)\s+\((\S+)\s*→\s*(\S+)\)\s*-\s*(.+)$/;

export function parsePhaseLog(body: string): PhaseLogEntry[] {
  const entries: PhaseLogEntry[] = [];
  const logSectionIdx = body.indexOf("## フェーズログ");
  if (logSectionIdx === -1) return entries;

  const logSection = body.slice(logSectionIdx);
  for (const line of logSection.split("\n")) {
    const m = line.match(PHASE_LOG_HEADER_RE);
    if (m) {
      entries.push({
        phase: m[1],
        result: m[2],
        next: m[3],
        timestamp: m[4].trim(),
      });
    }
  }
  return entries;
}

export function appendPhaseLog(body: string, entry: string): string {
  if (body.includes("## フェーズログ")) {
    return body + entry;
  }

  let result = body;
  if (result.length > 0 && !result.endsWith("\n")) {
    result += "\n";
  }
  result += "\n## フェーズログ\n";
  result += entry;
  return result;
}
