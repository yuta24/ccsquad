import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export class PhaseLogStore {
  constructor(private logsDir: string) {}

  ensureDir(): void {
    mkdirSync(this.logsDir, { recursive: true });
  }

  private filePath(jobId: string): string {
    return join(this.logsDir, `${jobId}.md`);
  }

  append(jobId: string, entry: string): void {
    const path = this.filePath(jobId);
    if (!existsSync(path)) {
      this.ensureDir();
      writeFileSync(path, entry, "utf-8");
    } else {
      appendFileSync(path, entry, "utf-8");
    }
  }

  read(jobId: string): string {
    const path = this.filePath(jobId);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }
}
