import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stringify, parse as parseYaml } from "yaml";
import { parse as parseFrontmatter, write as writeFrontmatter } from "./frontmatter.js";
import { CcsquadError } from "./error.js";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "aborted" | "closed";

export interface JobFrontmatter {
  id: string;
  title: string;
  workflow: string;
  status: JobStatus;
  current_phase?: string;
  priority: number;
  depends_on: string[];
  created_at: string; // ISO 8601 string
  updated_at: string; // ISO 8601 string
}

export interface Job {
  frontmatter: JobFrontmatter;
  body: string;
}

export function appendPhaseLog(job: Job, phase: string, result: string, next: string, message: string): void {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const entry = message === ""
    ? `### ${phase} (${result} → ${next}) - ${timestamp}\n\n`
    : `### ${phase} (${result} → ${next}) - ${timestamp}\n${message}\n\n`;

  if (job.body.includes("## フェーズログ")) {
    job.body += entry;
  } else {
    if (job.body.length > 0 && !job.body.endsWith("\n")) {
      job.body += "\n";
    }
    job.body += "\n## フェーズログ\n";
    job.body += entry;
  }
}

function serializeFrontmatter(fm: JobFrontmatter): string {
  const obj: Record<string, unknown> = {
    id: fm.id,
    title: fm.title,
    workflow: fm.workflow,
    status: fm.status,
  };
  if (fm.current_phase !== undefined) {
    obj.current_phase = fm.current_phase;
  }
  obj.priority = fm.priority;
  if ((fm.depends_on ?? []).length > 0) {
    obj.depends_on = fm.depends_on;
  }
  obj.created_at = fm.created_at;
  obj.updated_at = fm.updated_at;
  return stringify(obj);
}

export class JobStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  ensureDir(): void {
    try {
      mkdirSync(this.baseDir, { recursive: true });
    } catch (e) {
      throw new CcsquadError("io", `ディレクトリ作成エラー: ${e}`);
    }
  }

  private filePath(id: string): string {
    return join(this.baseDir, `${id}.md`);
  }

  nextId(): string {
    let maxNum = 0;
    if (existsSync(this.baseDir)) {
      let entries: string[];
      try {
        entries = readdirSync(this.baseDir);
      } catch (e) {
        throw new CcsquadError("io", `ディレクトリ読み込みエラー: ${e}`);
      }
      for (const name of entries) {
        if (name.startsWith("J") && name.endsWith(".md")) {
          const numStr = name.slice(1, -3);
          const num = parseInt(numStr, 10);
          if (!isNaN(num) && num > maxNum) {
            maxNum = num;
          }
        }
      }
    }
    return `J${String(maxNum + 1).padStart(6, "0")}`;
  }

  save(job: Job): void {
    const yaml = serializeFrontmatter(job.frontmatter);
    const content = writeFrontmatter(yaml, job.body);
    try {
      writeFileSync(this.filePath(job.frontmatter.id), content, "utf-8");
    } catch (e) {
      throw new CcsquadError("io", `ジョブ保存エラー: ${e}`);
    }
  }

  load(id: string): Job {
    const path = this.filePath(id);
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch (e: unknown) {
      if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CcsquadError("job", `ジョブ '${id}' が見つかりません`);
      }
      throw new CcsquadError("io", `ジョブ読み込みエラー: ${e}`);
    }

    let yaml: string;
    let body: string;
    try {
      ({ yaml, body } = parseFrontmatter(content));
    } catch (e) {
      throw new CcsquadError("serialization", `frontmatter パースエラー: ${e}`);
    }

    let fm: JobFrontmatter;
    try {
      fm = parseYaml(yaml) as JobFrontmatter;
    } catch (e) {
      throw new CcsquadError("serialization", `YAML パースエラー: ${e}`);
    }

    return { frontmatter: fm, body };
  }

  listAll(): Job[] {
    if (!existsSync(this.baseDir)) {
      return [];
    }

    let entries: string[];
    try {
      entries = readdirSync(this.baseDir);
    } catch (e) {
      throw new CcsquadError("io", `ディレクトリ読み込みエラー: ${e}`);
    }

    const jobs: Job[] = [];
    for (const name of entries) {
      if (name.startsWith("J") && name.endsWith(".md")) {
        const id = name.slice(0, -3);
        try {
          jobs.push(this.load(id));
        } catch {
          // skip unreadable job files (like Rust implementation)
        }
      }
    }

    jobs.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
    return jobs;
  }

  delete(id: string): void {
    const path = this.filePath(id);
    try {
      unlinkSync(path);
    } catch (e: unknown) {
      if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CcsquadError("job", `ジョブ '${id}' が見つかりません`);
      }
      throw new CcsquadError("io", `ジョブ削除エラー: ${e}`);
    }
  }
}
