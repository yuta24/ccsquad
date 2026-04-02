#!/usr/bin/env bun
import { Command } from "commander";

import { createProjectContext } from "./app/project-context.js";
import { CcsquadError } from "./error.js";
import { readFileSync } from "node:fs";
import {
  cmdList, cmdShow, cmdAdd, cmdRun, cmdTransition,
  cmdApprove, cmdReject, cmdAbort, cmdCancel, cmdSummary, cmdTree, cmdUpdate,
} from "./cli/commands/job.js";
import { cmdDagRun, cmdDagResume, cmdDagStatus, cmdDagClean } from "./cli/commands/dag.js";

const program = new Command();
program.name("ccsquad").description("ステートマシン型ワークフローエンジン CLI");

// ===== job commands =====
const jobCmd = program.command("job").description("ジョブ管理");

jobCmd.command("list").description("ジョブ一覧を表示")
  .option("--exclude-status <statuses>", "除外するステータス (カンマ区切り)")
  .action((opts: { excludeStatus?: string }) => {
    cmdList(createProjectContext(), { excludeStatus: opts.excludeStatus });
  });

jobCmd.command("show <id>").description("ジョブ詳細を表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((id: string, opts: { format: string }) => {
    cmdShow(createProjectContext(), id, opts.format === "json" ? "json" : "text");
  });

jobCmd.command("add <title>").description("ジョブを追加")
  .requiredOption("--phases <phases>", "フェーズ定義 (name:type, name:type:agent, name:type:agent1[constraint]+agent2[constraint] のカンマ区切り)")
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

jobCmd.command("cancel <id>").description("ジョブを取り下げ")
  .option("--force", "依存ジョブがある場合も強制的に取り下げ")
  .action((id: string, opts: { force?: boolean }) => {
    cmdCancel(createProjectContext(), id, { force: opts.force });
  });

jobCmd.command("summary <id>").description("ジョブのメトリクスサマリーを表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((id: string, opts: { format: string }) => {
    cmdSummary(createProjectContext(), id, opts.format === "json" ? "json" : "text");
  });

jobCmd.command("tree").description("ジョブ依存関係をツリー表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((opts: { format: string }) => {
    cmdTree(createProjectContext(), opts.format === "json" ? "json" : "text");
  });

jobCmd.command("update <id>").description("ジョブを更新")
  .option("--title <title>", "タイトル")
  .option("--priority <priority>", "優先度")
  .option("--description <description>", "説明 (- で stdin から読み込み)")
  .action((id: string, opts: { title?: string; priority?: string; description?: string }) => {
    const ctx = createProjectContext();

    let description: string | undefined;
    if (opts.description === "-") {
      description = readFileSync(0, "utf-8");
    } else {
      description = opts.description;
    }

    const priority = opts.priority !== undefined ? (parseInt(opts.priority, 10) || 0) : undefined;

    if (opts.title === undefined && priority === undefined && description === undefined) {
      console.error("エラー: --title, --priority, --description のいずれかを指定してください");
      process.exit(1);
    }

    cmdUpdate(ctx, id, { title: opts.title, priority, description });
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

// ===== tui command =====
program.command("tui").description("DAG ジョブ監視 TUI を起動")
  .action(async () => {
    const { cmdTui } = await import("./cli/commands/tui.js");
    await cmdTui();
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
