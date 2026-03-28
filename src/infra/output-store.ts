import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stringify, parse as parseYaml } from "yaml";
import { parse, write } from "./frontmatter.js";
import { CcsquadError } from "../error.js";
import type { NodeOutput } from "../domain/types.js";

interface FrontmatterData {
  phase: string;
  executor: string;
  result: string;
  session_id?: string;
  iteration: number;
  timestamp: string;
}

export class OutputStore {
  constructor(private baseDir: string) {}

  private jobDir(jobId: string): string {
    return join(this.baseDir, jobId);
  }

  private ensureJobDir(jobId: string): string {
    const dir = this.jobDir(jobId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private parseFile(filePath: string, fileName: string): NodeOutput {
    const seqMatch = fileName.match(/^(\d+)-/);
    if (!seqMatch) {
      throw new CcsquadError("serialization", `Invalid output filename: ${fileName}`);
    }
    const seq = parseInt(seqMatch[1], 10);

    const raw = readFileSync(filePath, "utf-8");
    let parsed: { yaml: string; body: string };
    try {
      parsed = parse(raw);
    } catch (e) {
      throw new CcsquadError("serialization", `Failed to parse frontmatter in ${fileName}: ${e}`);
    }

    let data: unknown;
    try {
      data = parseYaml(parsed.yaml);
    } catch (e) {
      throw new CcsquadError("serialization", `Failed to parse YAML in ${fileName}: ${e}`);
    }

    if (typeof data !== "object" || data === null) {
      throw new CcsquadError("serialization", `Invalid frontmatter in ${fileName}`);
    }

    const fm = data as Record<string, unknown>;

    return {
      seq,
      phase: fm.phase as string,
      executor: fm.executor as string,
      result: fm.result as string,
      sessionId: fm.session_id as string | undefined,
      iteration: fm.iteration as number,
      timestamp: fm.timestamp as string,
      content: parsed.body,
    };
  }

  save(jobId: string, output: Omit<NodeOutput, "seq">): void {
    const dir = this.ensureJobDir(jobId);

    let existingFiles: string[] = [];
    try {
      existingFiles = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch (e) {
      throw new CcsquadError("io", `Failed to read job directory: ${e}`);
    }

    const seq = existingFiles.length + 1;
    const fileName = `${seq}-${output.phase}.md`;
    const filePath = join(dir, fileName);

    const fm: FrontmatterData = {
      phase: output.phase,
      executor: output.executor,
      result: output.result,
      iteration: output.iteration,
      timestamp: output.timestamp,
    };
    if (output.sessionId !== undefined) {
      fm.session_id = output.sessionId;
    }

    const yamlStr = stringify(fm).trimEnd();
    const fileContent = write(yamlStr, output.content);

    try {
      writeFileSync(filePath, fileContent, "utf-8");
    } catch (e) {
      throw new CcsquadError("io", `Failed to write output file: ${e}`);
    }
  }

  loadForJob(jobId: string): NodeOutput[] {
    const dir = this.jobDir(jobId);
    if (!existsSync(dir)) {
      return [];
    }

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch (e) {
      throw new CcsquadError("io", `Failed to read job directory: ${e}`);
    }

    const outputs = files.map((fileName) => this.parseFile(join(dir, fileName), fileName));
    outputs.sort((a, b) => a.seq - b.seq);
    return outputs;
  }

  latest(jobId: string): NodeOutput | undefined {
    const all = this.loadForJob(jobId);
    return all.length > 0 ? all[all.length - 1] : undefined;
  }

  findLastByPhase(jobId: string, phase: string): NodeOutput | undefined {
    const all = this.loadForJob(jobId);
    const filtered = all.filter((o) => o.phase === phase);
    return filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
  }

  listFilesForJob(jobId: string): { phase: string; seq: number; filePath: string }[] {
    const dir = this.jobDir(jobId);
    if (!existsSync(dir)) {
      return [];
    }

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch (e) {
      throw new CcsquadError("io", `Failed to read job directory: ${e}`);
    }

    return files
      .map((fileName) => {
        const seqMatch = fileName.match(/^(\d+)-(.+)\.md$/);
        if (!seqMatch) return null;
        return {
          seq: parseInt(seqMatch[1], 10),
          phase: seqMatch[2],
          filePath: join(dir, fileName),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.seq - b.seq);
  }

  remove(jobId: string): void {
    const dir = this.jobDir(jobId);
    if (!existsSync(dir)) {
      return;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      throw new CcsquadError("io", `Failed to remove job directory: ${e}`);
    }
  }
}
