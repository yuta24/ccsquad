import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stringify, parse as parseYaml } from "yaml";
import { parse as parseFrontmatter, write as writeFrontmatter } from "./frontmatter.js";
import { CcsquadError } from "../error.js";
import type { Severity } from "../domain/types.js";
import type { RetrospectiveReport, RetrospectiveFinding, FindingCategory } from "../domain/retrospective.js";
import type { JobMetrics } from "../domain/metrics.js";

function serializeReport(report: RetrospectiveReport): string {
  const obj: Record<string, unknown> = {
    job_id: report.jobId,
    job_title: report.jobTitle,
    job_status: report.jobStatus,
    created_at: report.createdAt,
    summary: report.summary,
    findings: report.findings,
    metrics: {
      id: report.metrics.id,
      title: report.metrics.title,
      status: report.metrics.status,
      iteration: report.metrics.iteration,
      max_iterations: report.metrics.maxIterations,
      duration_ms: report.metrics.durationMs,
      reject_count: report.metrics.rejectCount,
      review_transition_count: report.metrics.reviewTransitionCount,
      phase_stats: report.metrics.phaseStats,
    },
  };
  return stringify(obj);
}

function deserializeReport(yaml: string): RetrospectiveReport {
  const raw = parseYaml(yaml) as Record<string, unknown>;

  const metricsRaw = raw.metrics as Record<string, unknown>;
  const phaseStatsRaw = (metricsRaw.phase_stats ?? []) as Array<Record<string, unknown>>;

  const metrics: JobMetrics = {
    id: metricsRaw.id as string,
    title: metricsRaw.title as string,
    status: metricsRaw.status as string,
    iteration: metricsRaw.iteration as number,
    maxIterations: metricsRaw.max_iterations as number,
    durationMs: metricsRaw.duration_ms as number | null,
    rejectCount: metricsRaw.reject_count as number,
    reviewTransitionCount: metricsRaw.review_transition_count as number,
    phaseStats: phaseStatsRaw.map((ps) => ({
      phase: ps.phase as string,
      durationMs: (ps.durationMs ?? ps.duration_ms) as number,
      transitions: (ps.transitions ?? {}) as Record<string, number>,
    })),
  };

  const findingsRaw = (raw.findings ?? []) as Array<Record<string, unknown>>;
  const findings: RetrospectiveFinding[] = findingsRaw.map((f) => ({
    category: f.category as FindingCategory,
    severity: f.severity as Severity,
    ...(f.phase ? { phase: f.phase as string } : {}),
    description: f.description as string,
    suggestion: f.suggestion as string,
  }));

  return {
    jobId: raw.job_id as string,
    jobTitle: raw.job_title as string,
    jobStatus: raw.job_status as string,
    createdAt: raw.created_at as string,
    metrics,
    findings,
    summary: raw.summary as string,
  };
}

export class RetrospectiveStore {
  constructor(private baseDir: string) {}

  ensureDir(): void {
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePath(jobId: string): string {
    return join(this.baseDir, `${jobId}.md`);
  }

  save(report: RetrospectiveReport): void {
    this.ensureDir();
    const yaml = serializeReport(report);
    const content = writeFrontmatter(yaml, "");
    try {
      writeFileSync(this.filePath(report.jobId), content, "utf-8");
    } catch (e) {
      throw new CcsquadError("io", `振り返りレポート保存エラー: ${e}`);
    }
  }

  load(jobId: string): RetrospectiveReport {
    const path = this.filePath(jobId);
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch (e: unknown) {
      if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CcsquadError("io", `振り返りレポート '${jobId}' が見つかりません`);
      }
      throw new CcsquadError("io", `振り返りレポート読み込みエラー: ${e}`);
    }

    const { yaml } = parseFrontmatter(content);
    return deserializeReport(yaml);
  }

  list(): RetrospectiveReport[] {
    if (!existsSync(this.baseDir)) return [];

    let entries: string[];
    try {
      entries = readdirSync(this.baseDir);
    } catch (e) {
      throw new CcsquadError("io", `ディレクトリ読み込みエラー: ${e}`);
    }

    const reports: RetrospectiveReport[] = [];
    for (const name of entries) {
      if (name.startsWith("J") && name.endsWith(".md")) {
        const jobId = name.slice(0, -3);
        try {
          reports.push(this.load(jobId));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`警告: 振り返り ${jobId} の読み込みをスキップしました: ${msg}\n`);
        }
      }
    }

    reports.sort((a, b) => a.jobId.localeCompare(b.jobId));
    return reports;
  }

  exists(jobId: string): boolean {
    return existsSync(this.filePath(jobId));
  }
}
