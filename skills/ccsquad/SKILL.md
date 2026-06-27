---
name: ccsquad
description: タスクタイトルを受け取り、ccsquad ワークフローで plan→execute→review の全ステップを自律実行する。--workflow で basic（人間レビュー必須）・develop（全自動）・gated（計画のみ人間承認、以降自動）から選択。
argument-hint: <task-title> [--workflow basic|develop|simple|gated]
---

# ccsquad 自律実行スキル

タスクタイトルを受け取り、ccsquad ジョブを作成・実行する。
plan → execute → review の各フェーズを自律的にこなし、人間レビューが必要な場合は停止してユーザーに通知する。

**あなたの役割**: このスキルを実行するセッションは、ジョブの進行を管理する**オーケストレーター**である。要件分析・設計判断・実装・レビューといった作業そのものは一切行わず、各フェーズに対応するサブエージェントへ委譲する。あなた自身が担うのは、フェーズ遷移の制御と結果の集約・報告のみである。長い手順の途中でこの境界を見失わないこと。

## 引数

- `$ARGUMENTS` — タスクタイトル。`--workflow <preset>` でプリセットを指定（デフォルト: `develop`）

例:
- `/ccsquad 認証機能を追加する`
- `/ccsquad 認証機能を追加する --workflow basic`
- `/ccsquad 認証機能を追加する --workflow gated`

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

Agent ツールでサブエージェントを起動する。
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

#### exit 2 — 一時停止（人間の判断待ち）

ループを停止する。状態確認のため以下を実行する:

```bash
ccsquad show $ID --format json
```

結果の `pause_reason` / `current_phase` / `suggested_commands` を確認し、ユーザーへ通知する。

- `pause_reason: human_review`
  - `current_phase: plan_gate`（`gated` ワークフロー）→ 計画と Acceptance Criteria の承認待ち。`ccsquad show $ID` で計画内容と AC を確認してもらう
  - `current_phase: review`（その他のワークフロー）→ 実装レビュー待ち。実装内容を確認してもらう
- `pause_reason: max_iterations` → 最大イテレーションに到達。完了・失敗・中断のいずれにするかをユーザーに判断してもらう

通知例:

```
ジョブ $ID が一時停止しています（フェーズ: <current_phase>, 理由: <pause_reason>）。
内容を確認して以下を実行してください:

  <suggested_commands の各コマンド>
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
- ループの最大イテレーション数は ccsquad 側で管理（デフォルト 10）。上限に達した場合はユーザーに報告して終了

**サブエージェント:**
- 各フェーズの作業指示・判断基準は `$PROMPT`（`ccsquad prompt` の出力）に含まれる
- 並列エージェントの場合、`ccsquad done` を呼び出すのはオーケストレーター（このスキル）のみ。各サブエージェントは作業のみ行い、遷移は行わない
