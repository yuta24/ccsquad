import type { Job } from "./types.js";
import type { JobMetrics, PhaseStats } from "./metrics.js";
import { formatDuration } from "./metrics.js";

// ── Types ──

export type FindingCategory =
  | "high_reject_rate"
  | "long_phase"
  | "iteration_overflow"
  | "plan_insufficient"
  | "fast_completion"
  | "low_ac_fulfillment";

export interface RetrospectiveFinding {
  category: FindingCategory;
  severity: "info" | "warning" | "critical";
  phase?: string;
  description: string;
  suggestion: string;
}

export interface RetrospectiveReport {
  jobId: string;
  jobTitle: string;
  jobStatus: string;
  createdAt: string;
  metrics: JobMetrics;
  findings: RetrospectiveFinding[];
  summary: string;
}

// ── Thresholds ──

const REJECT_RATE_WARNING = 0.3;
const REJECT_RATE_CRITICAL = 0.5;
const PLAN_RATIO_THRESHOLD = 0.1;
const LONG_PHASE_RATIO = 0.6;
const AC_FULFILLMENT_THRESHOLD = 0.8;

// ── Analysis ──

export function analyzeJob(job: Job, metrics: JobMetrics): RetrospectiveReport {
  const findings: RetrospectiveFinding[] = [];

  analyzeRejectRate(metrics, findings);
  analyzeIterationOverflow(job, metrics, findings);
  analyzePlanRatio(metrics, findings);
  analyzeLongPhase(metrics, findings);
  analyzeFastCompletion(metrics, findings);
  analyzeAcFulfillment(metrics, findings);

  const summary = buildSummary(job, metrics, findings);

  return {
    jobId: job.frontmatter.id,
    jobTitle: job.frontmatter.title,
    jobStatus: job.frontmatter.status,
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    metrics,
    findings,
    summary,
  };
}

function analyzeRejectRate(metrics: JobMetrics, findings: RetrospectiveFinding[]): void {
  if (metrics.reviewTransitionCount === 0) return;

  const rate = metrics.rejectCount / metrics.reviewTransitionCount;
  if (rate >= REJECT_RATE_CRITICAL) {
    findings.push({
      category: "high_reject_rate",
      severity: "critical",
      description: `リジェクト率が ${Math.round(rate * 100)}% (${metrics.rejectCount}/${metrics.reviewTransitionCount}) と高い`,
      suggestion: "Acceptance Criteria をより具体的にするか、plan フェーズを追加・強化してください",
    });
  } else if (rate >= REJECT_RATE_WARNING) {
    findings.push({
      category: "high_reject_rate",
      severity: "warning",
      description: `リジェクト率が ${Math.round(rate * 100)}% (${metrics.rejectCount}/${metrics.reviewTransitionCount})`,
      suggestion: "レビュー基準を明確にし、execute フェーズでのセルフチェックを強化してください",
    });
  }
}

function analyzeIterationOverflow(job: Job, metrics: JobMetrics, findings: RetrospectiveFinding[]): void {
  const maxIter = job.frontmatter.max_iterations;
  if (metrics.iteration >= maxIter) {
    findings.push({
      category: "iteration_overflow",
      severity: "critical",
      description: `イテレーション上限に到達 (${metrics.iteration}/${maxIter})`,
      suggestion: "タスクを分割するか、max_iterations を引き上げてください。reject 理由のパターンを確認し、根本原因を解消してください",
    });
  } else if (metrics.iteration >= maxIter * 0.8) {
    findings.push({
      category: "iteration_overflow",
      severity: "warning",
      description: `イテレーション上限の 80% 以上を消費 (${metrics.iteration}/${maxIter})`,
      suggestion: "タスクの複雑さに対して max_iterations が不足している可能性があります",
    });
  }
}

function analyzePlanRatio(metrics: JobMetrics, findings: RetrospectiveFinding[]): void {
  if (metrics.durationMs === null || metrics.durationMs === 0) return;

  const planPhases = metrics.phaseStats.filter((ps) => isPlanPhase(ps));
  if (planPhases.length === 0) return;

  const planDuration = planPhases.reduce((sum, ps) => sum + ps.durationMs, 0);
  const ratio = planDuration / metrics.durationMs;

  if (ratio < PLAN_RATIO_THRESHOLD && metrics.rejectCount > 0) {
    findings.push({
      category: "plan_insufficient",
      severity: "warning",
      description: `plan フェーズの時間比率が ${Math.round(ratio * 100)}% と低く、リジェクトが発生している`,
      suggestion: "plan フェーズにより多くの時間を割くか、設計レビューフェーズを追加してください",
    });
  }
}

function analyzeLongPhase(metrics: JobMetrics, findings: RetrospectiveFinding[]): void {
  if (metrics.durationMs === null || metrics.durationMs === 0) return;

  for (const ps of metrics.phaseStats) {
    const ratio = ps.durationMs / metrics.durationMs;
    if (ratio >= LONG_PHASE_RATIO) {
      findings.push({
        category: "long_phase",
        severity: "warning",
        phase: ps.phase,
        description: `フェーズ "${ps.phase}" が全体の ${Math.round(ratio * 100)}% (${formatDuration(ps.durationMs)}) を占有`,
        suggestion: "このフェーズをサブフェーズに分割するか、エージェントの制約条件を見直してください",
      });
    }
  }
}

function analyzeFastCompletion(metrics: JobMetrics, findings: RetrospectiveFinding[]): void {
  if (metrics.status !== "completed") return;
  if (metrics.rejectCount === 0 && metrics.iteration <= 1) {
    findings.push({
      category: "fast_completion",
      severity: "info",
      description: "リジェクトなしで完了。ワークフローが効果的に機能しています",
      suggestion: "このワークフローパターンを類似タスクのテンプレートとして活用できます",
    });
  }
}

function analyzeAcFulfillment(metrics: JobMetrics, findings: RetrospectiveFinding[]): void {
  if (metrics.acTotalCount === 0) return;
  if (metrics.status !== "completed" && metrics.status !== "failed") return;

  const rate = metrics.acFulfilledCount / metrics.acTotalCount;
  if (metrics.status === "completed" && rate < AC_FULFILLMENT_THRESHOLD) {
    findings.push({
      category: "low_ac_fulfillment",
      severity: "warning",
      description: `AC 充足率が ${Math.round(rate * 100)}% (${metrics.acFulfilledCount}/${metrics.acTotalCount}) で完了。一部の基準が未達のまま承認されています`,
      suggestion: "レビュー時に全 AC 項目を厳密にチェックし、未達項目がある場合は reject してください",
    });
  } else if (metrics.status === "failed" && metrics.acFulfilledCount > 0 && rate < 1) {
    findings.push({
      category: "low_ac_fulfillment",
      severity: "info",
      description: `失敗ジョブの AC 充足率: ${Math.round(rate * 100)}% (${metrics.acFulfilledCount}/${metrics.acTotalCount})。部分的に達成済みの基準があります`,
      suggestion: "達成済みの AC を引き継いで、残りの基準に集中する後続ジョブを検討してください",
    });
  }
}

function isPlanPhase(ps: PhaseStats): boolean {
  return ps.phase.includes("plan") || ps.phase.includes("research") || ps.phase.includes("design");
}

function buildSummary(job: Job, metrics: JobMetrics, findings: RetrospectiveFinding[]): string {
  const critical = findings.filter((f) => f.severity === "critical").length;
  const warning = findings.filter((f) => f.severity === "warning").length;
  const info = findings.filter((f) => f.severity === "info").length;

  const parts: string[] = [];
  parts.push(`ジョブ ${job.frontmatter.id} (${job.frontmatter.status})`);

  if (metrics.durationMs !== null) {
    parts.push(`所要時間 ${formatDuration(metrics.durationMs)}`);
  }
  if (metrics.reviewTransitionCount > 0) {
    const rate = Math.round((metrics.rejectCount / metrics.reviewTransitionCount) * 100);
    parts.push(`reject 率 ${rate}%`);
  }

  parts.push(`検出: critical ${critical}, warning ${warning}, info ${info}`);

  return parts.join(", ");
}

// ── Formatters ──

export function formatRetrospectiveText(report: RetrospectiveReport): string {
  const lines: string[] = [];

  lines.push(`# 振り返り: ${report.jobId} - ${report.jobTitle}`);
  lines.push("");
  lines.push(`ステータス: ${report.jobStatus}`);
  lines.push(`分析日時: ${report.createdAt}`);
  lines.push("");
  lines.push(`## サマリー`);
  lines.push(report.summary);
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("検出事項はありません。");
  } else {
    lines.push(`## 検出事項 (${report.findings.length} 件)`);
    lines.push("");
    for (const f of report.findings) {
      const badge = f.severity === "critical" ? "[CRITICAL]" : f.severity === "warning" ? "[WARNING]" : "[INFO]";
      const phaseStr = f.phase ? ` (${f.phase})` : "";
      lines.push(`${badge}${phaseStr} ${f.description}`);
      lines.push(`  -> ${f.suggestion}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function formatRetrospectiveJson(report: RetrospectiveReport): Record<string, unknown> {
  return {
    job_id: report.jobId,
    job_title: report.jobTitle,
    job_status: report.jobStatus,
    created_at: report.createdAt,
    summary: report.summary,
    findings: report.findings.map((f) => ({
      category: f.category,
      severity: f.severity,
      ...(f.phase ? { phase: f.phase } : {}),
      description: f.description,
      suggestion: f.suggestion,
    })),
    metrics: {
      duration_ms: report.metrics.durationMs,
      iteration: report.metrics.iteration,
      max_iterations: report.metrics.maxIterations,
      reject_count: report.metrics.rejectCount,
      review_transition_count: report.metrics.reviewTransitionCount,
    },
  };
}
