import type { ProjectContext } from "../../app/project-context.js";
import type { JobStatus } from "../../domain/types.js";
import { ALL_JOB_STATUSES } from "../../domain/types.js";
import { CcsquadError } from "../../error.js";
import { computeMetrics } from "../../domain/metrics.js";
import { analyzeMultipleJobs, formatOptimizationText, formatOptimizationJson } from "../../domain/optimization.js";

const DEFAULT_STATUSES: JobStatus[] = ["completed", "failed", "aborted"];

function parseStatuses(statusStr?: string): Set<JobStatus> {
  if (!statusStr) return new Set(DEFAULT_STATUSES);

  const statuses = statusStr.split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of statuses) {
    if (!ALL_JOB_STATUSES.includes(s as JobStatus)) {
      throw new CcsquadError("config", `不正なステータス: ${s} (${ALL_JOB_STATUSES.join(", ")} のいずれかを指定してください)`);
    }
  }
  return new Set(statuses as JobStatus[]);
}

function collectMetrics(ctx: ProjectContext, statusFilter: Set<JobStatus>) {
  const jobs = ctx.jobStore.listAll();
  const filtered = jobs.filter((j) => statusFilter.has(j.frontmatter.status));

  const metricsList: Array<ReturnType<typeof computeMetrics> & {}> = [];
  for (const job of filtered) {
    const logContent = ctx.phaseLogStore.read(job.frontmatter.id);
    const metrics = computeMetrics(job, logContent);
    if (metrics) {
      metricsList.push(metrics);
    }
  }

  return metricsList;
}

export function cmdOptimizeAnalyze(ctx: ProjectContext, statusStr: string | undefined, format: "text" | "json"): void {
  const statusFilter = parseStatuses(statusStr);
  const metricsList = collectMetrics(ctx, statusFilter);

  if (metricsList.length === 0) {
    if (format === "json") {
      console.log(JSON.stringify({ job_count: 0, aggregate_stats: [], patterns: [] }, null, 2));
    } else {
      console.log("分析対象のジョブがありません。");
    }
    return;
  }

  const report = analyzeMultipleJobs(metricsList);

  if (format === "json") {
    console.log(JSON.stringify(formatOptimizationJson(report), null, 2));
  } else {
    console.log(formatOptimizationText(report));
  }
}

export function cmdOptimizeSuggest(ctx: ProjectContext, statusStr: string | undefined, format: "text" | "json"): void {
  const statusFilter = parseStatuses(statusStr);
  const metricsList = collectMetrics(ctx, statusFilter);

  if (metricsList.length === 0) {
    if (format === "json") {
      console.log(JSON.stringify({ suggestions: [] }, null, 2));
    } else {
      console.log("分析対象のジョブがありません。");
    }
    return;
  }

  const report = analyzeMultipleJobs(metricsList);

  if (report.patterns.length === 0) {
    if (format === "json") {
      console.log(JSON.stringify({ suggestions: [] }, null, 2));
    } else {
      console.log("改善提案はありません。ワークフローは健全に動作しています。");
    }
    return;
  }

  if (format === "json") {
    const suggestions = report.patterns.map((p) => ({
      pattern: p.pattern,
      severity: p.severity,
      description: p.description,
      affected_jobs: p.affectedJobs,
      suggestion: p.suggestion,
    }));
    console.log(JSON.stringify({ suggestions }, null, 2));
  } else {
    console.log(`# 改善提案 (${report.patterns.length} 件)`);
    console.log("");
    for (let i = 0; i < report.patterns.length; i++) {
      const p = report.patterns[i];
      const badge = p.severity === "critical" ? "[CRITICAL]" : p.severity === "warning" ? "[WARNING]" : "[INFO]";
      console.log(`${i + 1}. ${badge} ${p.description}`);
      if (p.affectedJobs.length > 0) {
        console.log(`   対象: ${p.affectedJobs.join(", ")}`);
      }
      console.log(`   提案: ${p.suggestion}`);
      console.log("");
    }
  }
}
