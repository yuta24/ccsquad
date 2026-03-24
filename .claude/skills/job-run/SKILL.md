---
name: job-run
description: |
  ジョブの現在フェーズに設定されたサブエージェントを起動してフェーズを実行する。
  `/job-run <ジョブID>` で呼び出す。
---

# ジョブ実行スキル

指定されたジョブの現在フェーズを確認し、ワークフローに設定されたサブエージェントを起動する。
サブエージェントには ccsquad の操作を委ねず、タスク情報をプロンプトで注入する。
フェーズ遷移はサブエージェントの結果を受けてこのスキル側で行う。

## 実行手順

引数からジョブ ID を取得する。引数がない場合はユーザーにジョブ ID を尋ねる。

### 1. ジョブ状態の取得

```bash
ccsquad job show <ID> --format json
```

- `status` が `pending` の場合 → `ccsquad job run <ID>` で開始してから再度 JSON を取得する
- `status` が `running` の場合 → ステップ 2 に進む
- `status` が `completed` / `failed` / `aborted` の場合 → 終了状態をユーザーに報告して終了する

### 2. サブエージェントの起動

JSON 出力の `phase_config` から以下を読み取る:

- `phase_config.agent` → 起動するサブエージェント名
- `phase_config.description` → フェーズの説明
- `phase_config.reviewer` → レビューアーの有無

Agent ツールで `subagent_type` に `phase_config.agent` の値を指定してサブエージェントを起動する。

プロンプトには以下のタスク情報を注入する:

```
以下のタスクを実行してください。

## タスク情報
- タイトル: {title}
- フェーズ: {current_phase} — {phase_config.description}

## 説明
{ジョブファイルの本文（description セクション）}

## フェーズログ
{ジョブファイルのフェーズログセクション（あれば）}
```

### 3. フェーズ遷移

サブエージェントの返却値（result と message）に基づいてフェーズを遷移する。

#### 通常フェーズの場合

- `result: completed` → `ccsquad job transition <ID> completed --message "<message>"`
- `result: failed` → `ccsquad job transition <ID> failed --message "<message>"`

#### reviewer フェーズの場合

- `result: approved` → `ccsquad job approve <ID> --message "<message>"`
- `result: rejected` → `ccsquad job reject <ID> --message "<message>"`

### 4. 結果の報告

フェーズ遷移後、`ccsquad job show <ID> --format json` でジョブの最新状態を取得し、ユーザーに以下を報告する:

- ジョブの現在ステータス（running / completed / failed / aborted）
- 現在のフェーズ（running の場合）
- フェーズログの最新エントリ

**1 回のスキル実行で起動するサブエージェントは 1 フェーズ分のみ。** 次のフェーズを実行するかはユーザーが判断し、再度 `/job-run <ID>` を実行する。
