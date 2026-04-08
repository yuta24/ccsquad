#!/usr/bin/env bun
import { Command } from "commander";

import { createProjectContext } from "./app/project-context.js";
import { CcsquadError } from "./error.js";
import { readFileSync } from "node:fs";
import {
  cmdList, cmdShow, cmdAdd, cmdRun, cmdTransition,
  cmdAbort, cmdTree, cmdUpdate,
  buildWorkflowConfig, parseWorkflowInput, parseAcInput,
} from "./cli/commands/job.js";
import { cmdDagRun, cmdDagResume, cmdDagStatus, cmdDagClean } from "./cli/commands/dag.js";
import { cmdRetroRun, cmdRetroShow, cmdRetroList } from "./cli/commands/retro.js";
import { cmdOptimizeAnalyze, cmdOptimizeSuggest } from "./cli/commands/optimize.js";

const program = new Command();
program.name("ccsquad").description("ステートマシン型ワークフローエンジン CLI");

// ===== job commands =====
const jobCmd = program.command("job").description("ジョブ管理");

jobCmd.command("list").description("ジョブ一覧を表示")
  .option("--exclude-status <statuses>", "除外するステータス (カンマ区切り)")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((opts: { excludeStatus?: string; format: string }) => {
    cmdList(createProjectContext(), { excludeStatus: opts.excludeStatus, format: opts.format === "json" ? "json" : "text" });
  });

jobCmd.command("show <id>").description("ジョブ詳細を表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((id: string, opts: { format: string }) => {
    cmdShow(createProjectContext(), id, opts.format === "json" ? "json" : "text");
  });

jobCmd.command("add <title>").description("ジョブを追加")
  .option("--workflow <workflow>", "ワークフロー定義 (JSON/YAML 文字列、ファイルパス、または - で stdin)")
  .option("--phases <phases>", "フェーズ定義 (name:type:agent のカンマ区切り)")
  .option("--transitions <transitions>", "遷移ルール (phase:condition>target のカンマ区切り)")
  .option("--description <description>", "説明")
  .option("--priority <priority>", "優先度", "0")
  .option("--depends-on <ids>", "依存ジョブ ID (カンマ区切り)")
  .option("--max-iterations <n>", "最大イテレーション数", "10")
  .option("--ac <ac>", "Acceptance Criteria (JSON/YAML 文字列、ファイルパス、または - で stdin)")
  .action((title: string, opts: { workflow?: string; phases?: string; transitions?: string; description?: string; priority: string; dependsOn?: string; maxIterations: string; ac?: string }) => {
    const ctx = createProjectContext();

    if (opts.workflow && (opts.phases || opts.transitions)) {
      console.error("エラー: --workflow と --phases/--transitions は同時に指定できません");
      process.exit(1);
    }
    if (!opts.workflow && !opts.phases) {
      console.error("エラー: --workflow または --phases/--transitions を指定してください");
      process.exit(1);
    }

    let workflowConfig;
    if (opts.workflow) {
      workflowConfig = parseWorkflowInput(opts.workflow);
    } else {
      if (!opts.transitions) {
        console.error("エラー: --phases と --transitions は両方指定してください");
        process.exit(1);
      }
      workflowConfig = buildWorkflowConfig(opts.phases!, opts.transitions);
    }

    const dependsOn = opts.dependsOn ? opts.dependsOn.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const ac = opts.ac ? parseAcInput(opts.ac) : undefined;
    cmdAdd(ctx, title, workflowConfig, opts.description, parseInt(opts.priority, 10) || 0, dependsOn, parseInt(opts.maxIterations, 10) || 10, ac);
  });

jobCmd.command("run <id>").description("ジョブを開始").action((id: string) => {
  cmdRun(createProjectContext(), id);
});

jobCmd.command("transition <id> <result>").description("フェーズ遷移")
  .option("--message <message>", "メッセージ", "")
  .action((id: string, result: string, opts: { message: string }) => {
    cmdTransition(createProjectContext(), id, result, opts.message);
  });

jobCmd.command("abort <id>").description("ジョブを中断").action((id: string) => {
  cmdAbort(createProjectContext(), id);
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
  .option("--workflow <workflow>", "ワークフロー定義 (JSON/YAML 文字列、ファイルパス、または - で stdin)")
  .option("--phases <phases>", "フェーズ定義 (name:type:agent のカンマ区切り)")
  .option("--transitions <transitions>", "遷移ルール (phase:condition>target のカンマ区切り)")
  .option("--ac <ac>", "Acceptance Criteria (JSON/YAML 文字列、ファイルパス、または - で stdin)")
  .action((id: string, opts: { title?: string; priority?: string; description?: string; workflow?: string; phases?: string; transitions?: string; ac?: string }) => {
    const ctx = createProjectContext();

    if (opts.workflow && (opts.phases || opts.transitions)) {
      console.error("エラー: --workflow と --phases/--transitions は同時に指定できません");
      process.exit(1);
    }
    if ((opts.phases && !opts.transitions) || (!opts.phases && opts.transitions)) {
      console.error("エラー: --phases と --transitions は両方指定してください");
      process.exit(1);
    }

    let description: string | undefined;
    if (opts.description === "-") {
      description = readFileSync(0, "utf-8");
    } else {
      description = opts.description;
    }

    const priority = opts.priority !== undefined ? (parseInt(opts.priority, 10) || 0) : undefined;
    let workflowConfig;
    if (opts.workflow) {
      workflowConfig = parseWorkflowInput(opts.workflow);
    } else if (opts.phases) {
      workflowConfig = buildWorkflowConfig(opts.phases, opts.transitions!);
    }

    let acceptanceCriteria;
    if (opts.ac) {
      acceptanceCriteria = parseAcInput(opts.ac);
    }

    if (opts.title === undefined && priority === undefined && description === undefined && workflowConfig === undefined && acceptanceCriteria === undefined) {
      console.error("エラー: --title, --priority, --description, --workflow, --phases/--transitions, --ac のいずれかを指定してください");
      process.exit(1);
    }

    cmdUpdate(ctx, id, { title: opts.title, priority, description, workflowConfig, acceptanceCriteria });
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

// ===== retro commands =====
const retroCmd = program.command("retro").description("ジョブ振り返り分析");

retroCmd.command("run <id>").description("振り返りを実行し保存する")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((id: string, opts: { format: string }) => {
    cmdRetroRun(createProjectContext(), id, opts.format === "json" ? "json" : "text");
  });

retroCmd.command("show <id>").description("保存済み振り返りを表示する")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((id: string, opts: { format: string }) => {
    cmdRetroShow(createProjectContext(), id, opts.format === "json" ? "json" : "text");
  });

retroCmd.command("list").description("振り返り一覧を表示する")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((opts: { format: string }) => {
    cmdRetroList(createProjectContext(), opts.format === "json" ? "json" : "text");
  });

// ===== optimize commands =====
const optimizeCmd = program.command("optimize").description("ワークフロー最適化");

optimizeCmd.command("analyze").description("全ジョブのメトリクスを横断分析する")
  .option("--status <statuses>", "分析対象のステータス (カンマ区切り)")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((opts: { status?: string; format: string }) => {
    cmdOptimizeAnalyze(createProjectContext(), opts.status, opts.format === "json" ? "json" : "text");
  });

optimizeCmd.command("suggest").description("改善提案を出力する")
  .option("--status <statuses>", "分析対象のステータス (カンマ区切り)")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((opts: { status?: string; format: string }) => {
    cmdOptimizeSuggest(createProjectContext(), opts.status, opts.format === "json" ? "json" : "text");
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
