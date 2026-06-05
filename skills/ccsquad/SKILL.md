---
name: ccsquad
description: タスクタイトルを受け取り、ccsquad ワークフローで plan→execute→review の全ステップを自律実行する。--workflow で basic（人間レビュー必須）か develop（全自動）を選択。
argument-hint: <task-title> [--workflow basic|develop|simple]
---

# ccsquad 自律実行スキル

タスクタイトルを受け取り、ccsquad ジョブを作成・実行する。
plan → execute → review の各フェーズを自律的にこなし、人間レビューが必要な場合は停止してユーザーに通知する。

## 引数

- `$ARGUMENTS` — タスクタイトル。`--workflow <preset>` でプリセットを指定（デフォルト: `develop`）

例:
- `/ccsquad 認証機能を追加する`
- `/ccsquad 認証機能を追加する --workflow basic`

## 手順

### 1. 引数のパース

`$ARGUMENTS` からタスクタイトルと `--workflow` オプションを取り出す。

- `--workflow` が指定されていない場合は `develop` を使用する
- タイトルは `--workflow <value>` 以外の文字列全体

### 2. ジョブの作成と開始

```bash
ID=$(ccsquad create "<タイトル>" --workflow <preset> 2>/dev/null)
echo "ジョブID: $ID"
ccsquad run $ID
```

### 3. フェーズループ

以下を繰り返す。`ccsquad prompt` の exit code でループを制御する。

```bash
PROMPT=$(ccsquad prompt $ID 2>/dev/null)
EXIT_CODE=$?
```

#### exit 0 — 実行継続

`$PROMPT` の「エージェント」行を確認する。

**単一エージェント（`エージェント: <name>`）:**

エージェント名を読み取り、Agent ツールでサブエージェントを1つ起動する。
サブエージェントには `$PROMPT` の内容をそのままプロンプトとして渡す。

**並列エージェント（`エージェント: 並列実行 (N エージェント)`）:**

`$PROMPT` 内の「並列エージェント構成」セクションを読み取り、Agent ツールを **複数同時呼び出し** する。
各エージェントへのプロンプトは `$PROMPT` 全体に加え、そのエージェントの `constraint` を末尾に付加する:

```
${PROMPT}

## 追加制約
${constraint}
```

全サブエージェントの完了を待ち、集約ルールに従って `ccsquad done` を呼び出す:
- 全エージェントが completed → `ccsquad done $ID completed --message "集約結果"`
- いずれかが failed → `ccsquad done $ID failed --message "失敗したエージェントと理由"`

サブエージェントが完了したら、exit code を再取得してループを続ける。

#### exit 2 — 人間レビュー待ち（basic ワークフロー）

ループを停止し、ユーザーに通知する:

```
レビュー待ち: ジョブ $ID が review フェーズで停止しています。
内容を確認して以下を実行してください:

  ccsquad done $ID approved  --message "承認理由"
  ccsquad done $ID rejected  --message "却下理由（未達 AC と改善指示を明記）"
```

#### exit 3 — ジョブ終了

ジョブの最終状態を取得して報告する:

```bash
ccsquad show $ID
ccsquad log $ID
```

完了・失敗・中断のいずれかをユーザーに伝えて終了。

## 制約

**オーケストレーター（このスキル）:**
- 作業の実施・判断はサブエージェントに委譲する。オーケストレーター自身は作業を行わない
- ループの最大イテレーション数は ccsquad 側で管理（デフォルト 10）。上限に達した場合はユーザーに報告して終了

**サブエージェント:**
- 各フェーズの作業指示・判断基準は `$PROMPT`（`ccsquad prompt` の出力）に含まれる
- 並列エージェントの場合、`ccsquad done` を呼び出すのはオーケストレーター（このスキル）のみ。各サブエージェントは作業のみ行い、遷移は行わない
