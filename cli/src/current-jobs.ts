import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CcsquadError } from "./error.js";

export class CurrentJobsStore {
  private filePath: string;

  constructor(private squadDir: string) {
    this.filePath = join(squadDir, "current-jobs.json");
  }

  private load(): string[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const content = readFileSync(this.filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new CcsquadError("serialization", `Failed to parse current-jobs.json: ${e}`);
    }
    if (!Array.isArray(parsed)) {
      throw new CcsquadError("serialization", "current-jobs.json must be a JSON array");
    }
    return parsed as string[];
  }

  private save(jobs: string[]): void {
    if (jobs.length === 0) {
      if (existsSync(this.filePath)) {
        unlinkSync(this.filePath);
      }
      return;
    }
    const content = JSON.stringify(jobs, null, 2);
    writeFileSync(this.filePath, content, "utf-8");
  }

  add(jobId: string): void {
    const jobs = this.load();
    if (!jobs.includes(jobId)) {
      jobs.push(jobId);
      this.save(jobs);
    }
  }

  remove(jobId: string): void {
    const jobs = this.load();
    const filtered = jobs.filter((id) => id !== jobId);
    this.save(filtered);
  }

  contains(jobId: string): boolean {
    const jobs = this.load();
    return jobs.includes(jobId);
  }

  list(): string[] {
    return this.load();
  }
}
