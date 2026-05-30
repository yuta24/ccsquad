import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify, parse as parseYaml } from "yaml";
import { parse as parseFrontmatter, write as writeFrontmatter } from "./frontmatter.js";
import { assertValidJobId } from "./job-id.js";
import { CcsquadError } from "../error.js";
import type { Job, JobFrontmatter, JobStatus, AcceptanceCriterion, PauseReason } from "../domain/types.js";
import { ALL_JOB_STATUSES, workflowToObject } from "../domain/types.js";
import { parseWorkflowObject } from "../domain/workflow.js";

function serializeFrontmatter(fm: JobFrontmatter): string {
  const obj: Record<string, unknown> = {
    id: fm.id,
    title: fm.title,
    status: fm.status,
  };
  if (fm.current_phase !== undefined) {
    obj.current_phase = fm.current_phase;
  }
  if (fm.pause_reason !== undefined) {
    obj.pause_reason = fm.pause_reason;
  }
  obj.iteration = fm.iteration;
  obj.max_iterations = fm.max_iterations;
  if ((fm.depends_on ?? []).length > 0) {
    obj.depends_on = fm.depends_on;
  }
  if (fm.acceptance_criteria.length > 0) {
    obj.acceptance_criteria = fm.acceptance_criteria;
  }
  obj.workflow = workflowToObject(fm.workflow);
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
    assertValidJobId(id);
    return join(this.baseDir, `${id}.md`);
  }

  nextId(): string {
    return formatJobId(this.nextIdNumber());
  }

  createWithNextId(buildJob: (id: string) => Job, validate?: (id: string) => void): Job {
    try {
      mkdirSync(this.baseDir, { recursive: true });
    } catch (e) {
      throw new CcsquadError("io", `ディレクトリ作成エラー: ${e}`);
    }

    let num = this.nextIdNumber();
    while (true) {
      const id = formatJobId(num);
      validate?.(id);

      const job = buildJob(id);
      if (job.frontmatter.id !== id) {
        throw new CcsquadError("job", `作成するジョブの ID が採番 ID と一致しません (${job.frontmatter.id} != ${id})`);
      }

      const yaml = serializeFrontmatter(job.frontmatter);
      const content = writeFrontmatter(yaml, job.body);
      const path = this.filePath(id);
      try {
        writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
        return job;
      } catch (e: unknown) {
        if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "EEXIST") {
          num += 1;
          continue;
        }
        throw new CcsquadError("io", `ジョブ作成エラー: ${e}`);
      }
    }
  }

  private nextIdNumber(): number {
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
    return maxNum + 1;
  }

  save(job: Job): void {
    assertValidJobId(job.frontmatter.id);
    const yaml = serializeFrontmatter(job.frontmatter);
    const content = writeFrontmatter(yaml, job.body);
    const path = this.filePath(job.frontmatter.id);
    const tmpPath = join(this.baseDir, `.${job.frontmatter.id}.${process.pid}.${randomUUID()}.tmp`);
    try {
      mkdirSync(this.baseDir, { recursive: true });
      writeFileSync(tmpPath, content, "utf-8");
      renameSync(tmpPath, path);
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
    if (raw["id"] !== id) {
      throw new CcsquadError("serialization", `frontmatter が不正です: id '${raw["id"]}' がファイル名 '${id}' と一致しません`);
    }
    if (typeof raw["title"] !== "string") {
      throw new CcsquadError("serialization", "frontmatter が不正です: title が文字列ではありません");
    }
    if (typeof raw["status"] !== "string") {
      throw new CcsquadError("serialization", "frontmatter が不正です: status が文字列ではありません");
    }
    if (!ALL_JOB_STATUSES.includes(raw["status"] as JobStatus)) {
      throw new CcsquadError("serialization", `frontmatter が不正です: 不正な status '${raw["status"]}' (${ALL_JOB_STATUSES.join(", ")} のいずれかを指定してください)`);
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

    // Parse acceptance_criteria
    let acceptanceCriteria: AcceptanceCriterion[] = [];
    if (raw["acceptance_criteria"] !== undefined) {
      if (!Array.isArray(raw["acceptance_criteria"])) {
        throw new CcsquadError("serialization", "frontmatter が不正です: acceptance_criteria は配列でなければなりません");
      }
      acceptanceCriteria = (raw["acceptance_criteria"] as unknown[]).map((item, i) => {
        if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>).description !== "string") {
          throw new CcsquadError("serialization", `frontmatter が不正です: acceptance_criteria[${i}] は { description: string, done: boolean } でなければなりません`);
        }
        const ac = item as Record<string, unknown>;
        return { description: String(ac.description), done: ac.done === true };
      });
    }

    // Parse pause_reason
    const pauseReason = raw["pause_reason"] as PauseReason | undefined;
    if (pauseReason !== undefined && pauseReason !== "human_review" && pauseReason !== "max_iterations") {
      throw new CcsquadError("serialization", `frontmatter が不正です: 不正な pause_reason '${pauseReason}'`);
    }

    if (typeof raw["created_at"] !== "string") {
      throw new CcsquadError("serialization", "frontmatter が不正です: created_at が文字列ではありません");
    }
    if (typeof raw["updated_at"] !== "string") {
      throw new CcsquadError("serialization", "frontmatter が不正です: updated_at が文字列ではありません");
    }

    // Parse workflow
    if (raw["workflow"] === undefined || raw["workflow"] === null) {
      throw new CcsquadError(
        "serialization",
        `frontmatter が不正です: workflow が定義されていません。このファイルは旧フォーマット (v0.2.0 以前) の可能性があります。新しいジョブを作成してください`,
      );
    }
    const workflow = parseWorkflowObject(raw["workflow"]);

    const fm: JobFrontmatter = {
      id: raw["id"] as string,
      title: raw["title"] as string,
      status: raw["status"] as JobStatus,
      current_phase: raw["current_phase"] as string | undefined,
      pause_reason: pauseReason,
      iteration: raw["iteration"] as number,
      max_iterations: raw["max_iterations"] as number,
      depends_on: (raw["depends_on"] as string[]) ?? [],
      acceptance_criteria: acceptanceCriteria,
      workflow,
      created_at: raw["created_at"] as string,
      updated_at: raw["updated_at"] as string,
    };

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
      if (/^J\d{6,}\.md$/.test(name)) {
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

function formatJobId(num: number): string {
  return `J${String(num).padStart(6, "0")}`;
}
