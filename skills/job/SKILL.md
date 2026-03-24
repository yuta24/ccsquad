---
name: job
description: |
  ccsquad CLI を使ったジョブ管理とステートマシン型ワークフローの操作。
  ジョブの作成・一覧・状態確認・フェーズ遷移・レビュー承認/却下・中断を行う。
  ユーザーがジョブやワークフローの操作を依頼した場合、またはタスクの進行管理が
  必要な場合にこのスキルを使用する。
---

# ccsquad job スキル

ccsquad CLI のジョブ管理機能を操作するスキル。ジョブはステートマシン型ワークフローに紐付いて管理される。

## 前提条件

- `ccsquad` CLI バイナリがパスに存在すること
- プロジェクトルートに `ccsquad.yaml` が存在すること

## ワークフロー設定 (ccsquad.yaml)

ワークフローは `ccsquad.yaml` で定義する。各フェーズの遷移先は `on:` で明示的に指定する。

```yaml
workflows:
  dev:
    description: 開発ワークフロー
    phases:
      plan:
        description: 実装計画を策定する
        agent: planner
        on:
          completed: code
          failed: ABORT
      code:
        description: コードを実装する
        agent: coder
        on:
          completed: review
          failed: plan
      review:
        description: コードレビューを行う
        agent: reviewer
        reviewer: human
        on:
          approved: COMPLETE
          rejected: code
```

### ワークフローの規約

- `phases` の最初のキーが開始フェーズになる
- 通常フェーズ: `on.completed` が必須
- reviewer フェーズ: `on.approved` と `on.rejected` が必須
- 特殊値: `COMPLETE`(成功終了)、`ABORT`(失敗終了)
- `on.failed` はオプション（定義しない場合、failed での遷移はエラーになる）

## CLI コマンド

### ジョブの作成

```bash
ccsquad job add "タイトル" --workflow <ワークフロー名> [--description "説明"] [--priority N] [--depends-on ID1,ID2]
```

- `--workflow` は必須。`ccsquad.yaml` に定義されたワークフロー名を指定する。
- `--depends-on` で依存ジョブを指定できる。循環依存はエラーになる。

### ジョブの一覧

```bash
ccsquad job list
```

### ジョブの詳細表示

```bash
ccsquad job show <ID>
ccsquad job show <ID> --format json
```

- `--format json` でマシンリーダブルな出力を得られる。現フェーズの設定（agent, reviewer）も含まれる。

### ジョブの編集

```bash
ccsquad job edit <ID> [--title "新タイトル"] [--description "新説明"] [--priority N] [--depends-on ID1,ID2]
```

- `status` や `current_phase` は変更不可（エンジンが管理するフィールド）。

### ジョブの開始

```bash
ccsquad job run <ID>
```

- ジョブのステータスが `pending` であること。
- `depends_on` のジョブがすべて `completed` であること。
- ワークフローの最初のフェーズにセットされ、ステータスが `running` になる。

### フェーズ遷移

```bash
ccsquad job transition <ID> <completed|failed> [--message "メッセージ"]
```

- reviewer フェーズでは使用不可（`approve`/`reject` を使う）。
- 対応する `on` ルールがなければエラー。

### レビュー承認/却下

```bash
ccsquad job approve <ID> [--message "メッセージ"]
ccsquad job reject <ID> --message "却下理由"
```

- reviewer フェーズでのみ使用可。
- `reject` は `--message` が必須。

### ジョブの中断

```bash
ccsquad job abort <ID>
```

- `pending` または `running` のジョブを `aborted` にする。

## ジョブのライフサイクル

```
[add]        → pending
[run]        → running (最初のフェーズ)
[transition] → running (次のフェーズ) or completed/failed
[approve]    → running (次のフェーズ) or completed
[reject]     → running (差し戻し先フェーズ)
[abort]      → aborted
```

- `completed`/`failed`/`aborted` のジョブは再実行できない。

## ジョブファイルの構造

ジョブは `.ccsquad/jobs/` 配下に YAML frontmatter + Markdown body として保存される。

```markdown
---
id: J000001
title: 認証機能の実装
workflow: dev
status: running
current_phase: code
priority: 5
depends_on: [J000001, J000002]
created_at: 2026-03-24T09:00:00Z
updated_at: 2026-03-24T11:00:00Z
---
## 説明
JWT ベースの認証機能を実装する。

## フェーズログ
### plan (completed → code) - 2026-03-24T10:00:00Z
計画を策定した。
```

## ワークフロー自動実行の例

ジョブの現在のフェーズ情報を取得してエージェントを起動する場合:

```bash
# ジョブの状態を JSON で取得
ccsquad job show J000001 --format json

# phase_config.agent を見て適切なエージェントを起動
# エージェント完了後にフェーズを遷移
ccsquad job transition J000001 completed --message "実装完了"
```
