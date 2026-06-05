import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const SKILL_MD = `---
name: ccsquad
description: タスクタイトルを受け取り、ccsquad ワークフローで plan→execute→review の全ステップを自律実行する。--workflow で basic（人間レビュー必須）か develop（全自動）を選択。
argument-hint: <task-title> [--workflow basic|develop|simple]
---

# ccsquad 自律実行スキル

タスクタイトルを受け取り、ccsquad ジョブを作成・実行する。
plan → execute → review の各フェーズを自律的にこなし、人間レビューが必要な場合は停止してユーザーに通知する。

## 引数

- \`$ARGUMENTS\` — タスクタイトル。\`--workflow <preset>\` でプリセットを指定（デフォルト: \`develop\`）

例:
- \`/ccsquad 認証機能を追加する\`
- \`/ccsquad 認証機能を追加する --workflow basic\`

## 手順

### 1. 引数のパース

\`$ARGUMENTS\` からタスクタイトルと \`--workflow\` オプションを取り出す。

- \`--workflow\` が指定されていない場合は \`develop\` を使用する
- タイトルは \`--workflow <value>\` 以外の文字列全体

### 2. ジョブの作成と開始

\`\`\`bash
ID=$(ccsquad create "<タイトル>" --workflow <preset> 2>/dev/null)
echo "ジョブID: $ID"
ccsquad run $ID
\`\`\`

### 3. フェーズループ

以下を繰り返す。\`ccsquad prompt\` の exit code でループを制御する。

\`\`\`bash
PROMPT=$(ccsquad prompt $ID 2>/dev/null)
EXIT_CODE=$?
\`\`\`

#### exit 0 — 実行継続

\`$PROMPT\` を読み、現在のフェーズに応じた作業を行う。

**plan フェーズの場合:**
1. タスクの要件・技術的課題を調査・分析する
2. 実装方針を決定する
3. Acceptance Criteria を定義して登録する:
   \`\`\`bash
   ccsquad update $ID --ac '[{"description":"基準1"},{"description":"基準2"}]'
   \`\`\`
4. 完了したら遷移:
   \`\`\`bash
   ccsquad done $ID completed --message "<計画内容の要約>"
   \`\`\`

**execute フェーズの場合:**
1. Acceptance Criteria を確認しながら実装・テストを行う
2. 完了したら遷移:
   \`\`\`bash
   ccsquad done $ID completed --message "<実装内容の要約>"
   \`\`\`
   失敗した場合:
   \`\`\`bash
   ccsquad done $ID failed --message "<失敗理由と引き継ぎ事項>"
   \`\`\`

**review フェーズの場合（auto:true）:**
1. 各 Acceptance Criteria を実際に検証する
2. 全て達成していれば:
   \`\`\`bash
   ccsquad done $ID approved --message "<各ACの達成根拠>"
   \`\`\`
   未達があれば:
   \`\`\`bash
   ccsquad done $ID rejected --message "<未達のAC名と具体的な改善指示>"
   \`\`\`

\`done\` 実行後、exit code を再取得してループを続ける。

#### exit 2 — 人間レビュー待ち（basic ワークフロー）

ループを停止し、ユーザーに通知する:

\`\`\`
レビュー待ち: ジョブ $ID が review フェーズで停止しています。
内容を確認して以下を実行してください:

  ccsquad done $ID approved  --message "承認理由"
  ccsquad done $ID rejected  --message "却下理由（未達 AC と改善指示を明記）"
\`\`\`

#### exit 3 — ジョブ終了

ジョブの最終状態を取得して報告する:

\`\`\`bash
ccsquad show $ID
ccsquad log $ID
\`\`\`

完了・失敗・中断のいずれかをユーザーに伝えて終了。

## 制約

- \`ccsquad done\` を実行する前に、必ず実際の作業（実装・検証など）を完了させること
- \`approved\` は Acceptance Criteria を一つずつ検証して達成を確認した場合のみ使用する
- \`completed\` / \`approved\` は「AC を満たした」と判断できる場合のみ。不確かな場合は \`failed\` / \`rejected\` を使う
- ループの最大イテレーション数は ccsquad 側で管理（デフォルト 10）。上限に達した場合はユーザーに報告して終了
`;

export function cmdSetup(opts: { dir?: string; global?: boolean; force?: boolean }): void {
  if (opts.global && opts.dir) {
    process.stderr.write("エラー: --global と --dir は同時に指定できません。\n");
    process.exit(1);
  }

  const skillDir = opts.global
    ? join(homedir(), ".claude", "skills", "ccsquad")
    : join(resolve(opts.dir ?? "."), ".claude", "skills", "ccsquad");
  const skillPath = join(skillDir, "SKILL.md");

  if (existsSync(skillPath) && !opts.force) {
    process.stderr.write(`スキルは既にインストール済みです: ${skillPath}\n`);
    process.stderr.write(`上書きするには --force を指定してください。\n`);
    process.exit(1);
  }

  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, SKILL_MD, "utf-8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`インストールに失敗しました: ${msg}\n`);
    process.exit(1);
  }

  process.stdout.write(`${skillPath}\n`);
  process.stderr.write(`ccsquad スキルをインストールしました: ${skillPath}\n`);
  process.stderr.write(`Claude Code で /ccsquad が使えるようになりました。\n`);
}
