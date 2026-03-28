import type { Job } from "./types.js";
import type { PhaseLogEntry } from "./phase-log.js";
import { parsePhaseLog } from "./phase-log.js";

export interface PhaseStats {
  phase: string;
  durationMs: number;
  transitions: Record<string, number>;
}

export interface JobMetrics {
  id: string;
  title: string;
  status: string;
  iteration: number;
  maxIterations: number;
  durationMs: number | null;
  rejectCount: number;
  reviewTransitionCount: number;
  phaseStats: PhaseStats[];
}

export function computeMetrics(job: Job): JobMetrics | null {
  const fm = job.frontmatter;
  const entries = parsePhaseLog(job.body);

  if (entries.length === 0) return null;

  const createdAt = new Date(fm.created_at).getTime();
  const updatedAt = new Date(fm.updated_at).getTime();
  const durationMs = updatedAt - createdAt;

  let rejectCount = 0;
  let reviewTransitionCount = 0;

  // Count reject rate: any entry whose result is "rejected" or "approved" counts as a review transition
  for (const entry of entries) {
    if (entry.result === "rejected" || entry.result === "approved") {
      reviewTransitionCount++;
      if (entry.result === "rejected") {
        rejectCount++;
      }
    }
  }

  // Phase stats: accumulate time and transition counts per phase
  const phaseOrder: string[] = [];
  const phaseMap = new Map<string, PhaseStats>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const phaseName = entry.phase;

    if (!phaseMap.has(phaseName)) {
      phaseOrder.push(phaseName);
      phaseMap.set(phaseName, { phase: phaseName, durationMs: 0, transitions: {} });
    }
    const stats = phaseMap.get(phaseName)!;

    // Duration: from the *start* of this phase to the timestamp of this entry
    // The start time of a phase is the timestamp of the previous entry (which transitioned into it),
    // or created_at for the very first entry.
    const entryTime = new Date(entry.timestamp).getTime();
    let startTime: number;
    if (i === 0) {
      // The first phase started when the job was started; approximate using created_at
      // or use the job's created_at
      startTime = createdAt;
    } else {
      startTime = new Date(entries[i - 1].timestamp).getTime();
    }
    stats.durationMs += entryTime - startTime;

    // Transition counts
    stats.transitions[entry.result] = (stats.transitions[entry.result] ?? 0) + 1;
  }

  return {
    id: fm.id,
    title: fm.title,
    status: fm.status,
    iteration: fm.iteration,
    maxIterations: fm.max_iterations,
    durationMs,
    rejectCount,
    reviewTransitionCount,
    phaseStats: phaseOrder.map((name) => phaseMap.get(name)!),
  };
}

export function formatDuration(ms: number): string {
  if (ms < 0) return "0m";
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function formatMetricsText(metrics: JobMetrics): string {
  const lines: string[] = [];

  lines.push(`ジョブ: ${metrics.id} - ${metrics.title}`);
  lines.push(`ステータス: ${metrics.status}`);
  lines.push(`総イテレーション: ${metrics.iteration} / ${metrics.maxIterations}`);
  if (metrics.durationMs !== null) {
    lines.push(`所要時間: ${formatDuration(metrics.durationMs)}`);
  }
  if (metrics.reviewTransitionCount > 0) {
    const pct = Math.round((metrics.rejectCount / metrics.reviewTransitionCount) * 100);
    lines.push(`reject 率: ${metrics.rejectCount}/${metrics.reviewTransitionCount} (${pct}%)`);
  } else {
    lines.push(`reject 率: 0/0 (0%)`);
  }

  lines.push("");
  lines.push("フェーズ別:");
  for (const ps of metrics.phaseStats) {
    const dur = formatDuration(ps.durationMs);
    const transStr = Object.entries(ps.transitions)
      .map(([cond, cnt]) => `${cond}\u00d7${cnt}`)
      .join(", ");
    lines.push(`  ${ps.phase.padEnd(10)}${dur.padEnd(8)}${transStr}`);
  }

  return lines.join("\n");
}

export function formatMetricsJson(metrics: JobMetrics): Record<string, unknown> {
  return {
    id: metrics.id,
    title: metrics.title,
    status: metrics.status,
    iteration: metrics.iteration,
    max_iterations: metrics.maxIterations,
    duration_ms: metrics.durationMs,
    reject_count: metrics.rejectCount,
    review_transition_count: metrics.reviewTransitionCount,
    reject_rate: metrics.reviewTransitionCount > 0
      ? metrics.rejectCount / metrics.reviewTransitionCount
      : 0,
    phases: metrics.phaseStats.map((ps) => ({
      phase: ps.phase,
      duration_ms: ps.durationMs,
      transitions: ps.transitions,
    })),
  };
}
