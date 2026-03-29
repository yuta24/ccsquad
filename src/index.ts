#!/usr/bin/env bun
import { Command } from "commander";

import { createProjectContext } from "./app/project-context.js";
import { CcsquadError } from "./error.js";
import {
  cmdList, cmdShow, cmdAdd, cmdRun, cmdTransition,
  cmdApprove, cmdReject, cmdAbort, cmdSummary,
} from "./cli/commands/job.js";
import { cmdDagRun, cmdDagResume, cmdDagStatus, cmdDagClean } from "./cli/commands/dag.js";

const program = new Command();
program.name("ccsquad").description("ステートマシン型ワークフローエンジン CLI");

// ===== job commands =====
const jobCmd = program.command("job").description("ジョブ管理");

jobCmd.command("list").description("ジョブ一覧を表示").action(() => {
  cmdList(createProjectContext());
});

jobCmd.command("show <id>").description("ジョブ詳細を表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((id: string, opts: { format: string }) => {
    cmdShow(createProjectContext(), id, opts.format === "json" ? "json" : "text");
  });

jobCmd.command("add <title>").description("ジョブを追加")
  .requiredOption("--phases <phases>", "フェーズ定義 (name:type または name:type:agent のカンマ区切り)")
  .requiredOption("--transitions <transitions>", "遷移ルール (phase:condition>target のカンマ区切り)")
  .option("--description <description>", "説明")
  .option("--priority <priority>", "優先度", "0")
  .option("--depends-on <ids>", "依存ジョブ ID (カンマ区切り)")
  .option("--max-iterations <n>", "最大イテレーション数", "10")
  .action((title: string, opts: { phases: string; transitions: string; description?: string; priority: string; dependsOn?: string; maxIterations: string }) => {
    const ctx = createProjectContext();
    const dependsOn = opts.dependsOn ? opts.dependsOn.split(",").map((s) => s.trim()).filter(Boolean) : [];
    cmdAdd(ctx, title, opts.phases, opts.transitions, opts.description, parseInt(opts.priority, 10) || 0, dependsOn, parseInt(opts.maxIterations, 10) || 10);
  });

jobCmd.command("run <id>").description("ジョブを開始").action((id: string) => {
  cmdRun(createProjectContext(), id);
});

jobCmd.command("transition <id> <result>").description("フェーズ遷移")
  .option("--message <message>", "メッセージ", "")
  .action((id: string, result: string, opts: { message: string }) => {
    cmdTransition(createProjectContext(), id, result, opts.message);
  });

jobCmd.command("approve <id>").description("レビュー承認")
  .option("--message <message>", "メッセージ", "")
  .action((id: string, opts: { message: string }) => {
    cmdApprove(createProjectContext(), id, opts.message);
  });

jobCmd.command("reject <id>").description("レビュー却下")
  .option("--message <message>", "メッセージ")
  .action((id: string, opts: { message?: string }) => {
    cmdReject(createProjectContext(), id, opts.message ?? "");
  });

jobCmd.command("abort <id>").description("ジョブを中断").action((id: string) => {
  cmdAbort(createProjectContext(), id);
});

jobCmd.command("summary <id>").description("ジョブのメトリクスサマリーを表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((id: string, opts: { format: string }) => {
    cmdSummary(createProjectContext(), id, opts.format === "json" ? "json" : "text");
  });

// ===== dag commands =====
const dagCmd = program.command("dag").description("DAG マルチジョブ並列実行");

dagCmd.command("run [ids...]").description("DAG 並列実行")
  .option("--max-concurrency <n>", "最大同時実行数", "4")
  .option("--no-cascade", "上流失敗時に依存ジョブを自動スキップしない")
  .option("--dry-run", "実行計画のみ表示")
  .action(async (ids: string[], opts: { maxConcurrency: string; cascade: boolean; dryRun: boolean }) => {
    await cmdDagRun(createProjectContext(), ids, {
      maxConcurrency: parseInt(opts.maxConcurrency, 10) || 4,
      noCascade: !opts.cascade,
      dryRun: opts.dryRun ?? false,
    });
  });

dagCmd.command("resume [ids...]").description("一時停止中のジョブを再開")
  .option("--max-concurrency <n>", "最大同時実行数", "4")
  .option("--no-cascade", "上流失敗時に依存ジョブを自動スキップしない")
  .action(async (ids: string[], opts: { maxConcurrency: string; cascade: boolean }) => {
    await cmdDagResume(createProjectContext(), ids, {
      maxConcurrency: parseInt(opts.maxConcurrency, 10) || 4,
      noCascade: !opts.cascade,
    });
  });

dagCmd.command("status").description("DAG 実行状態を表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action(async (opts: { format: string }) => {
    await cmdDagStatus(createProjectContext(), opts.format === "json" ? "json" : "text");
  });

dagCmd.command("clean").description("孤立 worktree のクリーンアップ")
  .action(async () => {
    await cmdDagClean(createProjectContext());
  });

// ===== entry point =====
try {
  await program.parseAsync();
} catch (e) {
  if (e instanceof CcsquadError) {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
