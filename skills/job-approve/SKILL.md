---
name: job-approve
description: |
  一時停止中のジョブを承認し、次の pause ポイントまで自動実行を再開する。
  `/job-approve <ジョブID>` で呼び出す。
---

# ジョブ承認スキル

pause フェーズで停止中のジョブを承認し、次のフェーズから自動連続実行を開始する。
SubagentStop hook が後続のフェーズ遷移を自動制御するため、このスキルは最初のサブエージェント起動のみ行う。

## 実行手順

引数からジョブ ID を取得する。引数がない場合はユーザーにジョブ ID を尋ねる。

### 1. ジョブ状態の確認

```bash
ccsquad job show <ID> --format json
```

- `status` が `running` でなければエラーを報告して終了する
- `current_phase` を確認する

### 2. フェーズ遷移の実行

pause で停止していたため、遷移は未実行の状態。ここで遷移を実行する:

```bash
ccsquad job transition <ID> completed --message "Human approved"
```

遷移後のジョブ状態を再取得:

```bash
ccsquad job show <ID> --format json
```

- `status` が `completed` / `failed` / `aborted` になった場合 → 終了状態を報告して終了

### 3. イテレーションカウンタのリセット

```bash
ccsquad job next-action <ID> --result completed --message "" --reset-iteration
```

**注意**: このステップは `next-action` の `--reset-iteration` フラグを利用する。
ただし、ステップ 2 で既に遷移を実行済みなので、ここでは遷移を行わない。
代わりに、以下のコマンドでリセットのみ行う:

実際の運用では、ステップ 2 の遷移後にアクティブジョブとして登録し、
サブエージェントを起動する。

### 4. アクティブジョブの登録

サブエージェント起動前に、ジョブをアクティブとして登録する:

```bash
ccsquad job activate <ID>
```

### 5. サブエージェントの起動

遷移後の `phase_config` から以下を読み取る:

- `phase_config.agent` → 起動するサブエージェント名
- `phase_config.description` → フェーズの説明

Agent ツールで `subagent_type` に `phase_config.agent` の値を指定してサブエージェントを起動する。

プロンプトには以下のタスク情報を注入する。
`## 出力規約` セクションは必ず含めること（エージェント定義に依存せず、スキル側で出力フォーマットを統一するため）。

reviewer フェーズの場合は result の選択肢を `approved / rejected` に変更する。

```
以下のタスクを実行してください。

## タスク情報
- タイトル: {title}
- フェーズ: {current_phase} — {phase_config.description}

## 説明
{ジョブファイルの本文（description セクション）}

## フェーズログ
{ジョブファイルのフェーズログセクション（あれば）}

## 出力規約
作業完了後、必ず最後のメッセージの末尾に以下の JSON 行を1行で出力すること:
{"job_id": "<ID>", "result": "completed", "message": "作業内容の要約"}
job_id には実行中のジョブ ID を必ず含めること。
result は completed / failed のいずれか。
```

### 6. 自動制御の開始

サブエージェント完了後は **SubagentStop hook** (`ccsquad hook on-agent-complete`) が自動的に:

1. サブエージェントの結果を解析
2. フェーズ遷移を実行
3. 次のアクション（continue / pause / done）を判定
4. 指示テキストを会話に注入

hook の指示に従ってください:

- `[CCSQUAD] ... 次のフェーズを自動実行します` → 指示通りにサブエージェントを起動
- `[CCSQUAD] ... 一時停止しました` → ユーザーに報告して終了
- `[CCSQUAD] ... 完了しました` → ユーザーに完了報告して終了
