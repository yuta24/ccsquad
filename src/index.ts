#!/usr/bin/env bun
import { Command } from "commander";

import { createProjectContext } from "./app/project-context.js";
import { CcsquadError } from "./error.js";
import { readFileSync } from "node:fs";
import {
  cmdList, cmdShow, cmdAdd, cmdRun, cmdTransition,
  cmdAbort, cmdUpdate, cmdLog,
  parseWorkflowInput, parseAcInput,
} from "./cli/commands/job.js";
import { cmdDagRun, cmdDagClean } from "./cli/commands/dag.js";

const program = new Command();
program
  .name("ccsquad")
  .description("ステートマシン型ワークフローエンジン CLI")
  .version("0.2.0")
  .addHelpText("after", `
基本ワークフロー:
  1. ジョブを作成する
       ccsquad job add "タスク名" --workflow workflow.yaml
  2. ジョブを開始する
       ccsquad job run <id>
  3. 現在のフェーズと次のコマンドを確認する
       ccsquad job show <id> --format json   # suggested_commands を確認
  4. 作業を実施し、記録を残す
       ccsquad job log <id> "作業内容のサマリー"
  5. フェーズを遷移する
       ccsquad job transition <id> completed --message "要約"
  6. レビューフェーズでは承認/却下を実行する
       ccsquad job transition <id> approved --message "理由"
       ccsquad job transition <id> rejected --message "理由"

フェーズタイプ:
  plan     調査・設計フェーズ。Acceptance Criteria を定義する
  execute  実装・テストフェーズ。Acceptance Criteria を満たすよう実装する
  review   レビューフェーズ。人間または自動で承認/却下を判定する

遷移条件:
  completed / failed   plan・execute フェーズから遷移する
  approved / rejected  review フェーズから遷移する`);

// ===== job commands =====
const jobCmd = program.command("job").description("ジョブ管理");

jobCmd.command("list").description("ジョブ一覧を表示")
  .option("--exclude-status <statuses>", "除外するステータス (カンマ区切り、例: completed,failed)")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((opts: { excludeStatus?: string; format: string }) => {
    cmdList(createProjectContext(), { excludeStatus: opts.excludeStatus, format: opts.format === "json" ? "json" : "text" });
  });

jobCmd.command("show <id>").description("ジョブ詳細を表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .addHelpText("after", `
JSON 出力には以下のフィールドが含まれます:
  phase_config      現在のフェーズの設定 (type, agent, auto)
  suggested_commands  次に実行すべきコマンドの候補

例:
  ccsquad job show J000001
  ccsquad job show J000001 --format json`)
  .action((id: string, opts: { format: string }) => {
    cmdShow(createProjectContext(), id, opts.format === "json" ? "json" : "text");
  });

jobCmd.command("add <title>").description("ジョブを追加")
  .option("--workflow <workflow>", "ワークフロー定義 (JSON/YAML 文字列、ファイルパス、または - で stdin)")
  .option("--description <description>", "説明")
  .option("--priority <priority>", "優先度 (数値、大きいほど高優先)", "0")
  .option("--depends-on <ids>", "依存ジョブ ID (カンマ区切り、例: J000001,J000002)")
  .option("--max-iterations <n>", "最大イテレーション数 (デフォルト: 10)", "10")
  .option("--ac <ac>", "Acceptance Criteria (JSON/YAML 文字列、ファイルパス、または - で stdin)")
  .addHelpText("after", `
ワークフロー定義の形式 (YAML):
  plan:
    type: plan
    agent: developer
    on:
      completed: code
      failed: ABORT
  code:
    type: execute
    agent: developer
    on:
      completed: review
      failed: plan
  review:
    type: review
    agent: reviewer
    on:
      approved: COMPLETE
      rejected: code

フェーズタイプ: plan / execute / review
遷移先の特殊値: COMPLETE (ジョブ完了) / ABORT (ジョブ失敗)
review フェーズに auto: true を設定するとエージェントが自動レビューを実行します。

Acceptance Criteria の形式:
  '["基準1", "基準2"]'
  '[{"description": "基準1"}, {"description": "基準2"}]'

例:
  ccsquad job add "機能実装" --workflow workflow.yaml --ac '["テストが通ること", "型エラーがないこと"]'`)
  .action((title: string, opts: { workflow: string; description?: string; priority: string; dependsOn?: string; maxIterations: string; ac?: string }) => {
    const ctx = createProjectContext();

    if (!opts.workflow) {
      console.error("エラー: --workflow を指定してください");
      process.exit(1);
    }

    const workflowConfig = parseWorkflowInput(opts.workflow);
    const dependsOn = opts.dependsOn ? opts.dependsOn.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const ac = opts.ac ? parseAcInput(opts.ac) : undefined;
    cmdAdd(ctx, title, workflowConfig, opts.description, parseInt(opts.priority, 10) || 0, dependsOn, parseInt(opts.maxIterations, 10) || 10, ac);
  });

jobCmd.command("run <id>").description("ジョブを開始 (pending → running)")
  .addHelpText("after", `
例:
  ccsquad job run J000001`)
  .action((id: string) => {
    cmdRun(createProjectContext(), id);
  });

jobCmd.command("transition <id> <result>").description("フェーズを遷移する")
  .option("--message <message>", "遷移メッセージ (次フェーズへの引き継ぎ情報)", "")
  .addHelpText("after", `
result の値:
  completed   plan / execute フェーズが成功した場合
  failed      plan / execute フェーズが失敗した場合
  approved    review フェーズで承認する場合
  rejected    review フェーズで却下する場合

遷移結果の type:
  continue    次のフェーズへ自動遷移 (nextPhase に遷移先フェーズ名)
  pause       一時停止 (reason: human_review または max_iterations)
  done        ジョブ終了 (status: completed または failed)

例:
  ccsquad job transition J000001 completed --message "テスト全件パス"
  ccsquad job transition J000001 approved  --message "LGTM"
  ccsquad job transition J000001 rejected  --message "テストカバレッジが不足"`)
  .action((id: string, result: string, opts: { message: string }) => {
    cmdTransition(createProjectContext(), id, result, opts.message);
  });

jobCmd.command("abort <id>").description("ジョブを中断 (→ aborted)")
  .action((id: string) => {
    cmdAbort(createProjectContext(), id);
  });

jobCmd.command("update <id>").description("ジョブを更新")
  .option("--title <title>", "タイトル")
  .option("--priority <priority>", "優先度")
  .option("--description <description>", "説明 (- で stdin から読み込み)")
  .option("--workflow <workflow>", "ワークフロー定義 (pending 状態のみ変更可)")
  .option("--ac <ac>", "Acceptance Criteria (JSON/YAML 文字列、ファイルパス、または - で stdin)")
  .addHelpText("after", `
例:
  ccsquad job update J000001 --ac '["テストが通ること", "型エラーがないこと"]'
  ccsquad job update J000001 --description - < description.md`)
  .action((id: string, opts: { title?: string; priority?: string; description?: string; workflow?: string; ac?: string }) => {
    const ctx = createProjectContext();

    let description: string | undefined;
    if (opts.description === "-") {
      description = readFileSync(0, "utf-8");
    } else {
      description = opts.description;
    }

    const priority = opts.priority !== undefined ? (parseInt(opts.priority, 10) || 0) : undefined;
    const workflowConfig = opts.workflow ? parseWorkflowInput(opts.workflow) : undefined;
    const acceptanceCriteria = opts.ac ? parseAcInput(opts.ac) : undefined;

    if (opts.title === undefined && priority === undefined && description === undefined && workflowConfig === undefined && acceptanceCriteria === undefined) {
      console.error("エラー: --title, --priority, --description, --workflow, --ac のいずれかを指定してください");
      process.exit(1);
    }

    cmdUpdate(ctx, id, { title: opts.title, priority, description, workflowConfig, acceptanceCriteria });
  });

jobCmd.command("log <id> <message>").description("フェーズログを記録する")
  .addHelpText("after", `
フェーズログは .ccsquad/logs/<id>.md に追記されます。
次フェーズのエージェントが前回の作業内容を把握するために使用します。
フェーズ遷移前に作業内容・判断・成果物のサマリーを記録してください。

例:
  ccsquad job log J000001 "認証モジュールを実装。JWT 方式を採用。テスト 12 件全件パス"
  ccsquad job log J000001 "設計完了。AC を 3 項目に絞った。既存コードとの互換性を確認済み"`)
  .action((id: string, message: string) => {
    cmdLog(createProjectContext(), id, message);
  });

// ===== dag commands =====
const dagCmd = program.command("dag").description("DAG マルチジョブ並列実行");

dagCmd.command("run [ids...]").description("DAG 並列実行")
  .option("--max-concurrency <n>", "最大同時実行数 (デフォルト: 4)", "4")
  .option("--no-cascade", "上流失敗時に依存ジョブを自動スキップしない")
  .option("--dry-run", "実行計画のみ表示 (実行しない)")
  .addHelpText("after", `
ids を省略すると pending 状態の全ジョブを対象にします。

例:
  ccsquad dag run                          # pending 全件を実行
  ccsquad dag run J000001 J000002          # 指定ジョブのみ実行
  ccsquad dag run --dry-run                # 実行計画を確認`)
  .action(async (ids: string[], opts: { maxConcurrency: string; cascade: boolean; dryRun: boolean }) => {
    await cmdDagRun(createProjectContext(), ids, {
      maxConcurrency: parseInt(opts.maxConcurrency, 10) || 4,
      noCascade: !opts.cascade,
      dryRun: opts.dryRun ?? false,
    });
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
  } else if (e instanceof Error) {
    console.error(`予期しないエラーが発生しました: ${e.message}`);
  } else {
    console.error(`予期しないエラーが発生しました: ${String(e)}`);
  }
  process.exit(1);
}
