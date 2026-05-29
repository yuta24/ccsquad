import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CcsquadError } from "../error.js";

export class LogStore {
  constructor(private logsDir: string) {}

  append(jobId: string, phase: string, message: string): void {
    try {
      mkdirSync(this.logsDir, { recursive: true });
    } catch (e) {
      throw new CcsquadError("io", `ログディレクトリ作成エラー: ${e}`);
    }

    const path = join(this.logsDir, `${jobId}.md`);
    const timestamp = new Date().toISOString();
    const entry = `\n## ${timestamp} [${phase}]\n\n${message.trim()}\n`;

    try {
      appendFileSync(path, entry, "utf-8");
    } catch (e) {
      throw new CcsquadError("io", `ログ書き込みエラー: ${e}`);
    }
  }

  read(jobId: string): string | null {
    const path = join(this.logsDir, `${jobId}.md`);
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, "utf-8");
    } catch (e) {
      throw new CcsquadError("io", `ログ読み込みエラー: ${e}`);
    }
  }

  logPath(jobId: string): string {
    return join(this.logsDir, `${jobId}.md`);
  }
}
