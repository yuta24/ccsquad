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
