import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CcsquadError } from "../error.js";

export class IterationStore {
  private filePath: string;

  constructor(squadDir: string) {
    this.filePath = join(squadDir, "iteration.json");
  }

  private load(): Record<string, number> {
    if (!existsSync(this.filePath)) {
      return {};
    }
    const content = readFileSync(this.filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new CcsquadError("serialization", `Failed to parse iteration.json: ${e}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CcsquadError("serialization", "iteration.json must be a JSON object");
    }
    return parsed as Record<string, number>;
  }

  private save(data: Record<string, number>): void {
    const content = JSON.stringify(data, null, 2);
    writeFileSync(this.filePath, content, "utf-8");
  }

  get(jobId: string): number {
    const data = this.load();
    return data[jobId] ?? 0;
  }

  increment(jobId: string): number {
    const data = this.load();
    data[jobId] = (data[jobId] ?? 0) + 1;
    this.save(data);
    return data[jobId];
  }

  reset(jobId: string): void {
    const data = this.load();
    data[jobId] = 0;
    this.save(data);
  }

  remove(jobId: string): void {
    const data = this.load();
    delete data[jobId];
    this.save(data);
  }
}
