#!/usr/bin/env bun
import { Command } from "commander";

import { createProjectContext } from "./app/project-context.js";
import { CcsquadError } from "./error.js";
import { readFileSync } from "node:fs";
import {
  cmdList, cmdShow, cmdCreate, cmdRun, cmdPrompt, cmdDone,
  cmdAbort, cmdUpdate, cmdDelete,
  parseWorkflowInput, parseAcInput,
} from "./cli/commands/job.js";
import { WORKFLOW_PRESETS } from "./domain/workflow.js";

const PRESET_NAMES = Object.keys(WORKFLOW_PRESETS).join(", ");

const program = new Command();
program
  .name("ccsquad")
  .description("ステートマシン型ワークフローエンジン CLI")
  .version("0.3.0")
  .addHelpText("after", `
基本ワークフロー:
  1. ジョブを作成する
       ID=$(ccsquad create "タスク名")
       ccsquad create "タスク名" --workflow basic
  2. ジョブを開始する
       ccsquad run <id>
  3. プロンプトを取得してエージェントに渡す
       ccsquad prompt <id>
       claude -p "$(ccsquad prompt <id>)"
  4. フェーズを遷移する（ログも自動記録）
       ccsquad done <id> completed --message "作業内容の要約"
  5. レビューフェーズでは承認/却下を実行する
       ccsquad done <id> approved --message "理由"
       ccsquad done <id> rejected --message "理由"

exit コード (prompt コマンド):
  0   プロンプト出力（実行継続）
  2   人間レビュー待ち
  3   ジョブ終了（completed / failed / aborted）

ワークフロープリセット:
  basic     plan → execute → review(human) → COMPLETE
  develop   plan → execute → review(auto)  → COMPLETE
  simple    execute → review(human) → COMPLETE`);

program.command("list").description("ジョブ一覧を表示")
  .option("--status <statuses>", "表示するステータス (カンマ区切り、例: running,paused)")
  .option("--exclude-status <statuses>", "除外するステータス (カンマ区切り、例: completed,failed)")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((opts: { status?: string; excludeStatus?: string; format: string }) => {
    cmdList(createProjectContext(), { status: opts.status, excludeStatus: opts.excludeStatus, format: opts.format === "json" ? "json" : "text" });
  });

program.command("show <id>").description("ジョブ詳細を表示")
  .option("--format <format>", "出力形式 (text|json|prompt)", "text")
  .addHelpText("after", `
prompt 出力: エージェントに渡すプロンプトを stdout に出力します。

例:
  ccsquad show J000001
  ccsquad show J000001 --format json
  ccsquad show J000001 --format prompt`)
  .action((id: string, opts: { format: string }) => {
    const format = opts.format === "json" ? "json" : opts.format === "prompt" ? "prompt" : "text";
    cmdShow(createProjectContext(), id, format);
  });

program.command("create <title>").description("ジョブを作成する")
  .option("--workflow <workflow>", `ワークフロー定義 (プリセット: ${PRESET_NAMES}、ファイルパス、または - で stdin)`, "basic")
  .option("--description <description>", "説明")
  .option("--depends-on <ids>", "依存ジョブ ID (カンマ区切り、例: J000001,J000002)")
  .option("--max-iterations <n>", "最大イテレーション数 (デフォルト: 10)", "10")
  .option("--ac <ac>", "Acceptance Criteria (JSON/YAML 文字列、ファイルパス、または - で stdin)")
  .addHelpText("after", `
stdout: ジョブ ID のみ出力 (パイプ対応)
  ID=$(ccsquad create "タスク名")
  ccsquad run $ID

ワークフロープリセット:
  basic     plan → execute → review(human) → COMPLETE  (デフォルト)
  develop   plan → execute → review(auto)  → COMPLETE
  simple    execute → review(human) → COMPLETE

カスタムワークフロー (YAML):
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
      completed: COMPLETE
      failed: plan

例:
  ccsquad create "機能実装"
  ccsquad create "機能実装" --workflow develop
  ccsquad create "機能実装" --workflow workflow.yaml --ac '["テストが通ること"]'`)
  .action((title: string, opts: { workflow: string; description?: string; dependsOn?: string; maxIterations: string; ac?: string }) => {
    const ctx = createProjectContext();
    const workflowConfig = parseWorkflowInput(opts.workflow);
    const dependsOn = opts.dependsOn ? opts.dependsOn.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const ac = opts.ac ? parseAcInput(opts.ac) : undefined;
    cmdCreate(ctx, title, workflowConfig, opts.description, dependsOn, parseInt(opts.maxIterations, 10) || 10, ac);
  });

program.command("run <id>").description("ジョブを開始する (pending → running)")
  .addHelpText("after", `
例:
  ccsquad run J000001`)
  .action((id: string) => {
    cmdRun(createProjectContext(), id);
  });

program.command("prompt <id>").description("現在のフェーズのプロンプトを stdout に出力する")
  .addHelpText("after", `
exit コード:
  0   プロンプト出力（実行継続）
  2   人間レビュー待ち（review フェーズ、auto:false）
  3   ジョブ終了（completed / failed / aborted）

例:
  ccsquad prompt J000001
  claude -p "$(ccsquad prompt J000001)"

  # ループ実行
  while ccsquad prompt $ID | claude --print -; do
    ccsquad done $ID completed --message "完了"
  done`)
  .action((id: string) => {
    const code = cmdPrompt(createProjectContext(), id);
    if (code !== 0) process.exit(code);
  });

program.command("done <id> <result>").description("フェーズを遷移する（--message はフェーズログに自動記録）")
  .option("--message <message>", "遷移メッセージ（次フェーズへの引き継ぎ情報・ログ）", "")
  .addHelpText("after", `
result の値:
  completed   plan / execute フェーズが成功した場合
  failed      plan / execute フェーズが失敗した場合
  approved    review フェーズで承認する場合
  rejected    review フェーズで却下する場合

--message の内容はフェーズログに自動記録されます。
別途 log コマンドを実行する必要はありません。

例:
  ccsquad done J000001 completed --message "テスト全件パス"
  ccsquad done J000001 approved  --message "LGTM"
  ccsquad done J000001 rejected  --message "テストカバレッジが不足"`)
  .action((id: string, result: string, opts: { message: string }) => {
    cmdDone(createProjectContext(), id, result, opts.message);
  });

program.command("abort <id>").description("ジョブを中断 (→ aborted)")
  .option("--message <message>", "中断理由（フェーズログに記録）")
  .addHelpText("after", `
例:
  ccsquad abort J000001
  ccsquad abort J000001 --message "方針変更のため中断"`)
  .action((id: string, opts: { message?: string }) => {
    cmdAbort(createProjectContext(), id, opts.message);
  });

program.command("delete <id>").description("ジョブを削除する")
  .addHelpText("after", `
例:
  ccsquad delete J000001`)
  .action((id: string) => {
    cmdDelete(createProjectContext(), id);
  });

program.command("update <id>").description("ジョブを更新")
  .option("--title <title>", "タイトル")
  .option("--description <description>", "説明 (- で stdin から読み込み)")
  .option("--workflow <workflow>", "ワークフロー定義 (pending 状態のみ変更可)")
  .option("--ac <ac>", "Acceptance Criteria (JSON/YAML 文字列、ファイルパス、または - で stdin)")
  .addHelpText("after", `
例:
  ccsquad update J000001 --ac '["テストが通ること", "型エラーがないこと"]'
  ccsquad update J000001 --description - < description.md`)
  .action((id: string, opts: { title?: string; description?: string; workflow?: string; ac?: string }) => {
    const ctx = createProjectContext();

    let description: string | undefined;
    if (opts.description === "-") {
      description = readFileSync(0, "utf-8");
    } else {
      description = opts.description;
    }

    const workflowConfig = opts.workflow ? parseWorkflowInput(opts.workflow) : undefined;
    const acceptanceCriteria = opts.ac ? parseAcInput(opts.ac) : undefined;

    if (opts.title === undefined && description === undefined && workflowConfig === undefined && acceptanceCriteria === undefined) {
      console.error("エラー: --title, --description, --workflow, --ac のいずれかを指定してください");
      process.exit(1);
    }

    cmdUpdate(ctx, id, { title: opts.title, description, workflowConfig, acceptanceCriteria });
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
