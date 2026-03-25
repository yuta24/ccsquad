#!/usr/bin/env bun
import { Command } from "commander";

import { createContext } from "./service/context.js";
import { CcsquadError } from "./error.js";
import {
  cmdList, cmdShow, cmdAdd, cmdEdit, cmdRun, cmdTransition,
  cmdApprove, cmdReject, cmdAbort, cmdClose,
  cmdNextAction,
} from "./commands/job.js";
import {
  cmdAdd as memoryCmdAdd, cmdList as memoryCmdList,
  cmdShow as memoryCmdShow, cmdEdit as memoryCmdEdit,
  cmdDelete as memoryCmdDelete, cmdSearch as memoryCmdSearch,
} from "./commands/memory.js";
import { cmdSetup } from "./commands/setup.js";

const program = new Command();
program.name("ccsquad").description("ジョブ管理 + ワークフローエンジン + メモリ管理 CLI");

// ===== job commands =====
const jobCmd = program.command("job").description("ジョブ管理");

jobCmd.command("list").description("ジョブ一覧を表示").action(() => {
  cmdList(createContext().store);
});

jobCmd.command("show <id>").description("ジョブ詳細を表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((id: string, opts: { format: string }) => {
    const ctx = createContext();
    cmdShow(ctx.store, ctx.config, id, opts.format === "json" ? "json" : "text");
  });

jobCmd.command("add <title>").description("ジョブを追加")
  .requiredOption("--workflow <workflow>", "ワークフロー名")
  .option("--description <description>", "説明")
  .option("--priority <priority>", "優先度", "0")
  .option("--depends-on <ids>", "依存ジョブ ID (カンマ区切り)")
  .action((title: string, opts: { workflow: string; description?: string; priority: string; dependsOn?: string }) => {
    const ctx = createContext();
    const dependsOn = opts.dependsOn ? opts.dependsOn.split(",").map((s) => s.trim()).filter(Boolean) : [];
    cmdAdd(ctx.store, ctx.config, title, opts.workflow, opts.description, parseInt(opts.priority, 10) || 0, dependsOn);
  });

jobCmd.command("edit <id>").description("ジョブを編集")
  .option("--title <title>", "タイトル")
  .option("--description <description>", "説明")
  .option("--priority <priority>", "優先度")
  .option("--depends-on <ids>", "依存ジョブ ID (カンマ区切り)")
  .action((id: string, opts: { title?: string; description?: string; priority?: string; dependsOn?: string }) => {
    const ctx = createContext();
    const dependsOn = opts.dependsOn ? opts.dependsOn.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    cmdEdit(ctx.store, id, opts.title, opts.description, opts.priority !== undefined ? parseInt(opts.priority, 10) || 0 : undefined, dependsOn);
  });

jobCmd.command("run <id>").description("ジョブを開始").action((id: string) => {
  const ctx = createContext();
  cmdRun(ctx.store, ctx.config, id);
});

jobCmd.command("transition <id> <result>").description("フェーズ遷移")
  .option("--message <message>", "メッセージ", "")
  .action((id: string, result: string, opts: { message: string }) => {
    const ctx = createContext();
    cmdTransition(ctx.store, ctx.config, id, result, opts.message);
  });

jobCmd.command("approve <id>").description("レビュー承認")
  .option("--message <message>", "メッセージ", "")
  .action((id: string, opts: { message: string }) => {
    const ctx = createContext();
    cmdApprove(ctx.store, ctx.config, id, opts.message);
  });

jobCmd.command("reject <id>").description("レビュー却下")
  .option("--message <message>", "メッセージ")
  .action((id: string, opts: { message?: string }) => {
    const ctx = createContext();
    cmdReject(ctx.store, ctx.config, id, opts.message ?? "");
  });

jobCmd.command("abort <id>").description("ジョブを中断").action((id: string) => {
  const ctx = createContext();
  cmdAbort(ctx.store, ctx.config, id);
});

jobCmd.command("close <id>").description("ジョブをクローズ").action((id: string) => {
  const ctx = createContext();
  cmdClose(ctx.store, ctx.config, ctx.iterationStore, id);
});

jobCmd.command("next-action <id>").description("サブエージェント完了後の次アクション判定")
  .requiredOption("--result <result>", "遷移条件")
  .option("--message <message>", "メッセージ", "")
  .option("--reset-iteration", "イテレーションをリセット", false)
  .action((id: string, opts: { result: string; message: string; resetIteration: boolean }) => {
    const ctx = createContext();
    cmdNextAction(ctx.store, ctx.config, ctx.iterationStore, id, opts.result, opts.message, opts.resetIteration);
  });

// ===== memory commands =====
const memCmd = program.command("memory").description("メモリ管理");

memCmd.command("add <title> [body]").description("エントリを追加")
  .option("--type <type>", "タイプ")
  .option("--file <file>", "ファイルから本文を読み込む")
  .action((title: string, body: string | undefined, opts: { type?: string; file?: string }) => {
    memoryCmdAdd(createContext().entryStore, title, opts.type, body, opts.file);
  });

memCmd.command("list").description("エントリ一覧を表示")
  .option("--type <type>", "タイプでフィルタ")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((opts: { type?: string; format: string }) => {
    memoryCmdList(createContext().entryStore, opts.type, opts.format === "json" ? "json" : "text");
  });

memCmd.command("show <key>").description("エントリ詳細を表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((key: string, opts: { format: string }) => {
    memoryCmdShow(createContext().entryStore, key, opts.format === "json" ? "json" : "text");
  });

memCmd.command("edit <key> [body]").description("エントリを編集")
  .option("--title <title>", "新タイトル")
  .option("--type <type>", "新タイプ")
  .option("--no-type", "タイプを削除")
  .option("--file <file>", "ファイルから本文を読み込む")
  .action((key: string, body: string | undefined, opts: { title?: string; type?: string; noType?: boolean; file?: string }) => {
    memoryCmdEdit(createContext().entryStore, key, opts.title, opts.type, opts.noType, body, opts.file);
  });

memCmd.command("delete <key>").description("エントリを削除").action((key: string) => {
  memoryCmdDelete(createContext().entryStore, key);
});

memCmd.command("search <query>").description("エントリを検索")
  .option("--type <type>", "タイプでフィルタ")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((query: string, opts: { type?: string; format: string }) => {
    memoryCmdSearch(createContext().entryStore, query, opts.type, opts.format === "json" ? "json" : "text");
  });

// ===== setup command =====
program.command("setup").description("プロジェクトに ccsquad をセットアップ")
  .option("--force", "既存ファイルを上書き", false)
  .option("--skip-skills", "スキルのインストールをスキップ", false)
  .option("--skip-agents", "エージェント定義のコピーをスキップ", false)
  .option("--skip-config", "ccsquad.yaml の作成をスキップ", false)
  .action((opts: { force: boolean; skipSkills: boolean; skipAgents: boolean; skipConfig: boolean }) => {
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
