import { existsSync } from "node:fs";
import type { ProjectContext } from "./project-context.js";

export function buildDoctorReport(ctx: ProjectContext): string {
  const jobs = ctx.jobStore.listAll();
  const lines = [
    "ccsquad doctor",
    "",
    "状態:",
    `  project_root: ${ctx.projectRoot}`,
    `  squad_dir:    ${ctx.squadDir} ${existsSync(ctx.squadDir) ? "OK" : "MISSING"}`,
    `  jobs_dir:     ${ctx.jobsDir} ${existsSync(ctx.jobsDir) ? "OK" : "MISSING"}`,
    `  logs_dir:     ${ctx.logsDir} ${existsSync(ctx.logsDir) ? "OK" : "MISSING"}`,
    `  jobs:         ${jobs.length}`,
    "",
    "自律実行の最小手順:",
    `  ID=$(ccsquad create "タスク名" --workflow develop 2>/dev/null)`,
    "  ccsquad run $ID",
    "  ccsquad prompt $ID",
    "",
    "エージェントへの渡し方:",
    `  claude -p "$(ccsquad prompt $ID)"`,
    "  codex exec \"$(ccsquad prompt $ID)\"",
    "",
    "Claude Code 権限設定例:",
    "  .claude/settings.json または ~/.claude/settings.json に Bash(ccsquad *) を許可してください。",
    "",
    "レビュー保護:",
    "  人間レビューを守る場合は approved / rejected の自動実行を deny してください。",
  ];

  return `${lines.join("\n")}\n`;
}
