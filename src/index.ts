#!/usr/bin/env bun
import { Command } from "commander";

import { createProjectContext } from "./app/project-context.js";
import { CcsquadError } from "./error.js";
import {
  cmdList, cmdShow, cmdAdd, cmdEdit, cmdUpdateSection, cmdRun, cmdTransition,
  cmdApprove, cmdReject, cmdAbort, cmdClose,
  cmdNextAction,
} from "./cli/commands/job.js";
import {
  cmdAdd as memoryCmdAdd, cmdList as memoryCmdList,
  cmdShow as memoryCmdShow, cmdEdit as memoryCmdEdit,
  cmdDelete as memoryCmdDelete, cmdSearch as memoryCmdSearch,
} from "./cli/commands/memory.js";
import { cmdSetup } from "./cli/commands/setup.js";
import { cmdSignal } from "./cli/commands/signal.js";
import { cmdLint } from "./cli/commands/lint.js";

const program = new Command();
program.name("ccsquad").description("ジョブ管理 + ワークフローエンジン + メモリ管理 CLI");

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
  .requiredOption("--workflow <workflow>", "ワークフロー名")
  .option("--description <description>", "説明")
  .option("--priority <priority>", "優先度", "0")
  .option("--depends-on <ids>", "依存ジョブ ID (カンマ区切り)")
  .action((title: string, opts: { workflow: string; description?: string; priority: string; dependsOn?: string }) => {
    const ctx = createProjectContext();
    const dependsOn = opts.dependsOn ? opts.dependsOn.split(",").map((s) => s.trim()).filter(Boolean) : [];
    cmdAdd(ctx, title, opts.workflow, opts.description, parseInt(opts.priority, 10) || 0, dependsOn);
  });

jobCmd.command("edit <id>").description("ジョブを編集")
  .option("--title <title>", "タイトル")
  .option("--description <description>", "説明")
  .option("--priority <priority>", "優先度")
  .option("--depends-on <ids>", "依存ジョブ ID (カンマ区切り)")
  .action((id: string, opts: { title?: string; description?: string; priority?: string; dependsOn?: string }) => {
    const ctx = createProjectContext();
    const dependsOn = opts.dependsOn ? opts.dependsOn.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    cmdEdit(ctx, id, opts.title, opts.description, opts.priority !== undefined ? parseInt(opts.priority, 10) || 0 : undefined, dependsOn);
  });

jobCmd.command("update-section <id> <section>").description("ジョブ本文のセクションを追加/更新")
  .option("--content <text>", "セクション内容")
  .option("--file <file>", "ファイルから内容を読み込む")
  .action((id: string, section: string, opts: { content?: string; file?: string }) => {
    const ctx = createProjectContext();
    let content = opts.content ?? "";
    if (opts.file) {
      const { readFileSync } = require("node:fs");
      content = readFileSync(opts.file, "utf-8");
    }
    cmdUpdateSection(ctx, id, section, content);
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

jobCmd.command("close <id>").description("ジョブをクローズ")
  .option("--force", "依存ジョブがあっても強制的にクローズ", false)
  .action((id: string, opts: { force: boolean }) => {
    cmdClose(createProjectContext(), id, opts.force);
  });

jobCmd.command("next-action <id>").description("サブエージェント完了後の次アクション判定")
  .requiredOption("--result <result>", "遷移条件")
  .option("--message <message>", "メッセージ", "")
  .option("--reset-iteration", "イテレーションをリセット", false)
  .action((id: string, opts: { result: string; message: string; resetIteration: boolean }) => {
    cmdNextAction(createProjectContext(), id, opts.result, opts.message, opts.resetIteration);
  });

// ===== memory commands =====
const memCmd = program.command("memory").description("メモリ管理");

memCmd.command("add <title> [body]").description("エントリを追加")
  .option("--type <type>", "タイプ")
  .option("--file <file>", "ファイルから本文を読み込む")
  .action((title: string, body: string | undefined, opts: { type?: string; file?: string }) => {
    memoryCmdAdd(createProjectContext().entryStore, title, opts.type, body, opts.file);
  });

memCmd.command("list").description("エントリ一覧を表示")
  .option("--type <type>", "タイプでフィルタ")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((opts: { type?: string; format: string }) => {
    memoryCmdList(createProjectContext().entryStore, opts.type, opts.format === "json" ? "json" : "text");
  });

memCmd.command("show <key>").description("エントリ詳細を表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((key: string, opts: { format: string }) => {
    memoryCmdShow(createProjectContext().entryStore, key, opts.format === "json" ? "json" : "text");
  });

memCmd.command("edit <key> [body]").description("エントリを編集")
  .option("--title <title>", "新タイトル")
  .option("--type <type>", "新タイプ")
  .option("--no-type", "タイプを削除")
  .option("--file <file>", "ファイルから本文を読み込む")
  .action((key: string, body: string | undefined, opts: { title?: string; type?: string; noType?: boolean; file?: string }) => {
    memoryCmdEdit(createProjectContext().entryStore, key, opts.title, opts.type, opts.noType, body, opts.file);
  });

memCmd.command("delete <key>").description("エントリを削除").action((key: string) => {
  memoryCmdDelete(createProjectContext().entryStore, key);
});

memCmd.command("search <query>").description("エントリを検索")
  .option("--type <type>", "タイプでフィルタ")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((query: string, opts: { type?: string; format: string }) => {
    memoryCmdSearch(createProjectContext().entryStore, query, opts.type, opts.format === "json" ? "json" : "text");
  });

// ===== signal commands =====
const signalCmd = program.command("signal").description("TUI にシグナルを送信");

signalCmd.command("notification").description("Notification シグナルを送信")
  .option("--job <id>", "ジョブ ID")
  .action((opts: { job?: string }) => {
    cmdSignal("notification", opts.job);
  });

signalCmd.command("stop").description("Stop シグナルを送信")
  .option("--job <id>", "ジョブ ID")
  .action((opts: { job?: string }) => {
    cmdSignal("stop", opts.job);
  });

// ===== lint command =====
program.command("lint").description("ccsquad.yaml を検証")
  .option("--config <path>", "設定ファイルのパス")
  .action((opts: { config?: string }) => {
    cmdLint(opts.config);
  });

// ===== setup command =====
program.command("setup").description("プロジェクトに ccsquad をセットアップ")
  .option("--force", "既存ファイルを上書き", false)
  .option("--skip-skills", "スキルのインストールをスキップ", false)
  .option("--skip-config", "ccsquad.yaml の作成をスキップ", false)
  .action((opts: { force: boolean; skipSkills: boolean; skipConfig: boolean }) => {
    cmdSetup(opts);
  });

// ===== tui command =====
program.command("tui").description("TUI を起動 (Claude Code 埋め込み)")
  .action(async () => {
    const { launchTui } = await import("./tui/app.js");
    await launchTui();
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
