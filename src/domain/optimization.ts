import type { Severity } from "./types.js";
import type { JobMetrics } from "./metrics.js";
import { formatDuration } from "./metrics.js";

// ── Types ──

export type OptimizationPatternKind =
  | "high_reject_rate"
  | "iteration_overflow"
  | "plan_insufficient"
  | "long_phase"
  | "short_plan_high_reject";

export interface AggregatePhaseStats {
  phase: string;
  avgDurationMs: number;
  totalDurationMs: number;
  totalTransitions: Record<string, number>;
  jobCount: number;
}

export interface OptimizationPattern {
  pattern: OptimizationPatternKind;
  severity: Severity;
  phase?: string;
  description: string;
  affectedJobs: string[];
  suggestion: string;
}

export interface OptimizationReport {
  createdAt: string;
  jobCount: number;
  aggregateStats: AggregatePhaseStats[];
  patterns: OptimizationPattern[];
}

// ── Thresholds ──

const OVERALL_REJECT_RATE_WARNING = 0.3;
const OVERALL_REJECT_RATE_CRITICAL = 0.5;
const ITERATION_OVERFLOW_RATIO = 0.8;

// ── Analysis ──

export function analyzeMultipleJobs(metricsList: JobMetrics[]): OptimizationReport {
  if (metricsList.length === 0) {
    return {
      createdAt: now(),
      jobCount: 0,
      aggregateStats: [],
      patterns: [],
    };
  }

  const allMetrics = metricsList;
  const aggregateStats = computeAggregateStats(allMetrics);
  const patterns: OptimizationPattern[] = [];

  detectHighRejectRate(allMetrics, patterns);
  detectIterationOverflow(allMetrics, patterns);
  detectShortPlanHighReject(allMetrics, patterns);
  detectLongPhase(allMetrics, aggregateStats, patterns);

  return {
    createdAt: now(),
    jobCount: allMetrics.length,
    aggregateStats,
    patterns,
  };
}

function computeAggregateStats(metricsList: JobMetrics[]): AggregatePhaseStats[] {
  const phaseMap = new Map<string, { totalDurationMs: number; transitions: Record<string, number>; jobIds: Set<string> }>();

  for (const metrics of metricsList) {
    for (const ps of metrics.phaseStats) {
      if (!phaseMap.has(ps.phase)) {
        phaseMap.set(ps.phase, { totalDurationMs: 0, transitions: {}, jobIds: new Set() });
      }
      const agg = phaseMap.get(ps.phase)!;
      agg.totalDurationMs += ps.durationMs;
      agg.jobIds.add(metrics.id);
      for (const [cond, cnt] of Object.entries(ps.transitions)) {
        agg.transitions[cond] = (agg.transitions[cond] ?? 0) + cnt;
      }
    }
  }

  const result: AggregatePhaseStats[] = [];
  for (const [phase, agg] of phaseMap) {
    result.push({
      phase,
      avgDurationMs: agg.jobIds.size > 0 ? agg.totalDurationMs / agg.jobIds.size : 0,
      totalDurationMs: agg.totalDurationMs,
      totalTransitions: agg.transitions,
      jobCount: agg.jobIds.size,
    });
  }

  return result;
}

function detectHighRejectRate(metricsList: JobMetrics[], patterns: OptimizationPattern[]): void {
  let totalRejects = 0;
  let totalReviewTransitions = 0;
  const highRejectJobs: string[] = [];

  for (const m of metricsList) {
    totalRejects += m.rejectCount;
    totalReviewTransitions += m.reviewTransitionCount;
    if (m.reviewTransitionCount > 0 && m.rejectCount / m.reviewTransitionCount >= OVERALL_REJECT_RATE_CRITICAL) {
      highRejectJobs.push(m.id);
    }
  }

  if (totalReviewTransitions === 0) return;

  const overallRate = totalRejects / totalReviewTransitions;
  if (overallRate >= OVERALL_REJECT_RATE_CRITICAL) {
    patterns.push({
      pattern: "high_reject_rate",
      severity: "critical",
      description: `全体のリジェクト率が ${Math.round(overallRate * 100)}% (${totalRejects}/${totalReviewTransitions})`,
      affectedJobs: highRejectJobs,
      suggestion: "レビュー基準の明確化、Acceptance Criteria の具体化、または execute 前のセルフチェックフェーズの追加を検討してください",
    });
  } else if (overallRate >= OVERALL_REJECT_RATE_WARNING) {
    patterns.push({
      pattern: "high_reject_rate",
      severity: "warning",
      description: `全体のリジェクト率が ${Math.round(overallRate * 100)}% (${totalRejects}/${totalReviewTransitions})`,
      affectedJobs: highRejectJobs,
      suggestion: "特定のジョブでリジェクトが集中していないか確認してください",
    });
  }
}

function detectIterationOverflow(metricsList: JobMetrics[], patterns: OptimizationPattern[]): void {
  const overflowJobs: string[] = [];
  for (const m of metricsList) {
    if (m.maxIterations > 0 && m.iteration / m.maxIterations >= ITERATION_OVERFLOW_RATIO) {
      overflowJobs.push(m.id);
    }
  }

  if (overflowJobs.length === 0) return;

  const ratio = overflowJobs.length / metricsList.length;
  if (ratio >= 0.3) {
    patterns.push({
      pattern: "iteration_overflow",
      severity: "critical",
      description: `${overflowJobs.length}/${metricsList.length} のジョブがイテレーション上限の 80% 以上を消費`,
      affectedJobs: overflowJobs,
      suggestion: "デフォルトの max_iterations を引き上げるか、タスクの粒度を小さくしてください",
    });
  } else if (overflowJobs.length > 0) {
    patterns.push({
      pattern: "iteration_overflow",
      severity: "warning",
      description: `${overflowJobs.length} 件のジョブがイテレーション上限付近に到達`,
      affectedJobs: overflowJobs,
      suggestion: "該当ジョブのタスク複雑度を確認し、必要に応じて分割を検討してください",
    });
  }
}

function detectShortPlanHighReject(metricsList: JobMetrics[], patterns: OptimizationPattern[]): void {
  const affectedJobs: string[] = [];

  for (const m of metricsList) {
    if (m.durationMs === null || m.durationMs === 0) continue;
    if (m.reviewTransitionCount === 0) continue;

    const planDuration = m.phaseStats
      .filter((ps) => ps.phase.includes("plan") || ps.phase.includes("research") || ps.phase.includes("design"))
      .reduce((sum, ps) => sum + ps.durationMs, 0);

    const planRatio = planDuration / m.durationMs;
    const rejectRate = m.rejectCount / m.reviewTransitionCount;

    if (planRatio < 0.1 && rejectRate >= 0.3) {
      affectedJobs.push(m.id);
    }
  }

  if (affectedJobs.length === 0) return;

  patterns.push({
    pattern: "short_plan_high_reject",
    severity: "warning",
    description: `${affectedJobs.length} 件のジョブで plan 時間が短く (< 10%) かつリジェクト率が高い`,
    affectedJobs,
    suggestion: "plan フェーズに十分な時間を確保するワークフロー設計に変更してください。事前設計の不足がリジェクトの原因の可能性があります",
  });
}

function detectLongPhase(metricsList: JobMetrics[], aggregateStats: AggregatePhaseStats[], patterns: OptimizationPattern[]): void {
  const totalDuration = aggregateStats.reduce((sum, s) => sum + s.totalDurationMs, 0);
  if (totalDuration === 0) return;

  for (const stat of aggregateStats) {
    const ratio = stat.totalDurationMs / totalDuration;
    if (ratio >= 0.6) {
      const affectedJobs = metricsList
        .filter((m) => m.phaseStats.some((ps) => ps.phase === stat.phase))
        .map((m) => m.id);

      patterns.push({
        pattern: "long_phase",
        severity: "warning",
        phase: stat.phase,
        description: `フェーズ "${stat.phase}" が全体の ${Math.round(ratio * 100)}% を占有 (平均 ${formatDuration(stat.avgDurationMs)})`,
        affectedJobs,
        suggestion: "このフェーズの分割、またはエージェントの最適化を検討してください",
      });
    }
  }
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ── Formatters ──

export function formatOptimizationText(report: OptimizationReport): string {
  const lines: string[] = [];

  lines.push(`# ワークフロー最適化レポート`);
  lines.push("");
  lines.push(`分析日時: ${report.createdAt}`);
  lines.push(`対象ジョブ数: ${report.jobCount}`);
  lines.push("");

  if (report.aggregateStats.length > 0) {
    lines.push(`## フェーズ別集計`);
    lines.push("");
    for (const stat of report.aggregateStats) {
      const transStr = Object.entries(stat.totalTransitions)
        .map(([cond, cnt]) => `${cond}\u00d7${cnt}`)
        .join(", ");
      lines.push(`  ${stat.phase}: 平均 ${formatDuration(stat.avgDurationMs)}, ${stat.jobCount} ジョブ, ${transStr}`);
    }
    lines.push("");
  }

  if (report.patterns.length === 0) {
    lines.push("最適化の提案はありません。");
  } else {
    lines.push(`## 検出パターン (${report.patterns.length} 件)`);
    lines.push("");
    for (const p of report.patterns) {
      const badge = p.severity === "critical" ? "[CRITICAL]" : p.severity === "warning" ? "[WARNING]" : "[INFO]";
      lines.push(`${badge} ${p.description}`);
      if (p.affectedJobs.length > 0) {
        lines.push(`  対象: ${p.affectedJobs.join(", ")}`);
      }
      lines.push(`  -> ${p.suggestion}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function formatOptimizationJson(report: OptimizationReport): Record<string, unknown> {
  return {
    created_at: report.createdAt,
    job_count: report.jobCount,
    aggregate_stats: report.aggregateStats.map((s) => ({
      phase: s.phase,
      avg_duration_ms: s.avgDurationMs,
      total_duration_ms: s.totalDurationMs,
      total_transitions: s.totalTransitions,
      job_count: s.jobCount,
    })),
    patterns: report.patterns.map((p) => ({
      pattern: p.pattern,
      severity: p.severity,
      description: p.description,
      affected_jobs: p.affectedJobs,
      suggestion: p.suggestion,
    })),
  };
}
