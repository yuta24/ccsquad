import type { ProjectContext } from "../../app/project-context.js";
import { CcsquadError } from "../../error.js";
import { computeMetrics } from "../../domain/metrics.js";
import { analyzeJob, formatRetrospectiveText, formatRetrospectiveJson } from "../../domain/retrospective.js";
import { padRight, truncate } from "../../util.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

export function cmdRetroRun(ctx: ProjectContext, id: string, format: "text" | "json"): void {
  const job = ctx.jobStore.load(id);

  if (!TERMINAL_STATUSES.has(job.frontmatter.status)) {
    throw new CcsquadError("job", `ジョブ '${id}' は終了していません (status: ${job.frontmatter.status})。振り返りは completed/failed/aborted のジョブに対してのみ実行できます`);
  }

  const logContent = ctx.phaseLogStore.read(id);
  const metrics = computeMetrics(job, logContent);
  if (!metrics) {
    throw new CcsquadError("job", `ジョブ '${id}' のフェーズログがありません。振り返りを実行するにはフェーズログが必要です`);
  }

  const report = analyzeJob(job, metrics);
  ctx.retrospectiveStore.save(report);

  if (format === "json") {
    console.log(JSON.stringify(formatRetrospectiveJson(report), null, 2));
  } else {
    console.log(formatRetrospectiveText(report));
    console.log(`振り返りを保存しました: ${id}`);
  }
}

export function cmdRetroShow(ctx: ProjectContext, id: string, format: "text" | "json"): void {
  const report = ctx.retrospectiveStore.load(id);

  if (format === "json") {
    console.log(JSON.stringify(formatRetrospectiveJson(report), null, 2));
  } else {
    console.log(formatRetrospectiveText(report));
  }
}

export function cmdRetroList(ctx: ProjectContext, format: "text" | "json"): void {
  const reports = ctx.retrospectiveStore.list();

  if (reports.length === 0) {
    if (format === "json") {
      console.log(JSON.stringify([], null, 2));
    } else {
      console.log("振り返りレポートはありません。");
    }
    return;
  }

  if (format === "json") {
    const items = reports.map((r) => ({
      job_id: r.jobId,
      job_title: r.jobTitle,
      job_status: r.jobStatus,
      created_at: r.createdAt,
      findings_count: r.findings.length,
      critical_count: r.findings.filter((f) => f.severity === "critical").length,
      warning_count: r.findings.filter((f) => f.severity === "warning").length,
    }));
    console.log(JSON.stringify(items, null, 2));
  } else {
    console.log(
      `${padRight("ジョブ", 10)} ${padRight("タイトル", 30)} ${padRight("ステータス", 12)} ${padRight("検出", 6)} ${padRight("分析日時", 20)}`,
    );
    console.log("-".repeat(80));
    for (const r of reports) {
      const critical = r.findings.filter((f) => f.severity === "critical").length;
      const warning = r.findings.filter((f) => f.severity === "warning").length;
      const findingsStr = critical > 0 ? `C${critical}/W${warning}` : warning > 0 ? `W${warning}` : "-";
      console.log(
        `${padRight(r.jobId, 10)} ${padRight(truncate(r.jobTitle, 28), 30)} ${padRight(r.jobStatus, 12)} ${padRight(findingsStr, 6)} ${padRight(r.createdAt, 20)}`,
      );
    }
  }
}
