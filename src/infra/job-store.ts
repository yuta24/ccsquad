import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stringify, parse as parseYaml } from "yaml";
import { parse as parseFrontmatter, write as writeFrontmatter } from "./frontmatter.js";
import { CcsquadError } from "../error.js";
import type { Job, JobFrontmatter, JobStatus } from "../domain/types.js";

const VALID_STATUSES: readonly JobStatus[] = ["pending", "running", "completed", "failed", "aborted", "cancelled"];

function serializeFrontmatter(fm: JobFrontmatter): string {
  const obj: Record<string, unknown> = {
    id: fm.id,
    title: fm.title,
    status: fm.status,
  };
  if (fm.current_phase !== undefined) {
    obj.current_phase = fm.current_phase;
  }
  obj.iteration = fm.iteration;
  obj.max_iterations = fm.max_iterations;
  obj.priority = fm.priority;
  if ((fm.depends_on ?? []).length > 0) {
    obj.depends_on = fm.depends_on;
  }
  obj.created_at = fm.created_at;
  obj.updated_at = fm.updated_at;
  return stringify(obj);
}

export class JobStore {
  constructor(private baseDir: string) {}

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

    let parsed: unknown;
    try {
      parsed = parseYaml(yaml);
    } catch (e) {
      throw new CcsquadError("serialization", `YAML パースエラー: ${e}`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new CcsquadError("serialization", "frontmatter が不正です: オブジェクトではありません");
    }

    const raw = parsed as Record<string, unknown>;
    if (typeof raw["id"] !== "string") {
      throw new CcsquadError("serialization", "frontmatter が不正です: id が文字列ではありません");
    }
    if (typeof raw["title"] !== "string") {
      throw new CcsquadError("serialization", "frontmatter が不正です: title が文字列ではありません");
    }
    if (typeof raw["status"] !== "string") {
      throw new CcsquadError("serialization", "frontmatter が不正です: status が文字列ではありません");
    }
    if (!VALID_STATUSES.includes(raw["status"] as JobStatus)) {
      throw new CcsquadError("serialization", `frontmatter が不正です: 不正な status '${raw["status"]}' (${VALID_STATUSES.join(", ")} のいずれかを指定してください)`);
    }

    // Apply defaults for iteration fields
    if (raw["iteration"] === undefined) raw["iteration"] = 0;
    if (raw["max_iterations"] === undefined) raw["max_iterations"] = 10;

    if (typeof raw["iteration"] !== "number" || !Number.isInteger(raw["iteration"]) || raw["iteration"] < 0) {
      throw new CcsquadError("serialization", `frontmatter が不正です: iteration は 0 以上の整数でなければなりません (値: ${raw["iteration"]})`);
    }
    if (typeof raw["max_iterations"] !== "number" || !Number.isInteger(raw["max_iterations"]) || raw["max_iterations"] < 1) {
      throw new CcsquadError("serialization", `frontmatter が不正です: max_iterations は 1 以上の整数でなければなりません (値: ${raw["max_iterations"]})`);
    }
    if (raw["priority"] !== undefined && typeof raw["priority"] !== "number") {
      throw new CcsquadError("serialization", `frontmatter が不正です: priority は数値でなければなりません (値: ${raw["priority"]})`);
    }
    if (raw["depends_on"] !== undefined && !Array.isArray(raw["depends_on"])) {
      throw new CcsquadError("serialization", "frontmatter が不正です: depends_on は配列でなければなりません");
    }
    if (Array.isArray(raw["depends_on"])) {
      for (const dep of raw["depends_on"]) {
        if (typeof dep !== "string") {
          throw new CcsquadError("serialization", `frontmatter が不正です: depends_on の要素は文字列でなければなりません (値: ${dep})`);
        }
      }
    }

    const fm = parsed as JobFrontmatter;
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
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`警告: ジョブ ${id} の読み込みをスキップしました: ${msg}\n`);
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
