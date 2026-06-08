import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CcsquadError } from "../error.js";
import { assertValidJobId } from "./job-id.js";

// .ccsquad/plans/<jobId>.md を管理する。plan フェーズの成果物（調査結果・設計判断・実装方針などをまとめた計画文書）を
// ジョブにつき1ファイルで保持し、フェーズが進むたびに上書きされる「最新の計画」を表す。
export class PlanStore {
  constructor(private plansDir: string) {}

  write(jobId: string, content: string): void {
    assertValidJobId(jobId);
    try {
      mkdirSync(this.plansDir, { recursive: true });
    } catch (e) {
      throw new CcsquadError("io", `プランディレクトリ作成エラー: ${e}`);
    }

    const path = join(this.plansDir, `${jobId}.md`);
    try {
      writeFileSync(path, content, "utf-8");
    } catch (e) {
      throw new CcsquadError("io", `プラン書き込みエラー: ${e}`);
    }
  }

  read(jobId: string): string | null {
    assertValidJobId(jobId);
    const path = join(this.plansDir, `${jobId}.md`);
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, "utf-8");
    } catch (e) {
      throw new CcsquadError("io", `プラン読み込みエラー: ${e}`);
    }
  }

  delete(jobId: string): void {
    assertValidJobId(jobId);
    const path = join(this.plansDir, `${jobId}.md`);
    if (!existsSync(path)) return;
    try {
      unlinkSync(path);
    } catch (e) {
      throw new CcsquadError("io", `プラン削除エラー: ${e}`);
    }
  }

  planPath(jobId: string): string {
    assertValidJobId(jobId);
    return join(this.plansDir, `${jobId}.md`);
  }
}
