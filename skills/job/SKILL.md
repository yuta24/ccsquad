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

## ワークフローの定義

ワークフローはジョブ作成時にインラインで指定する。事前定義ファイルは不要。

### フェーズタイプ

- **plan**: 調査・計画・タスク分解を行うフェーズ。遷移条件は `completed` / `failed`。
- **execute**: コーディング・タスク実行を行うフェーズ。遷移条件は `completed` / `failed`。
- **review**: コードレビュー・動作確認を行うフェーズ。遷移条件は `approved` / `rejected`。

### ワークフローの規約

- フェーズの最初の要素が開始フェーズになる
- 特殊値: `COMPLETE`(成功終了)、`ABORT`(失敗終了)
- review フェーズへの遷移は常に一時停止する（人間の判断を待つ）

## CLI コマンド

### ジョブの作成

```bash
ccsquad job add "タイトル" \
  --phases "research:plan,design:plan,code:execute,review:review,verify:review" \
  --transitions "research:completed>design,research:failed>ABORT,design:completed>code,design:failed>ABORT,code:completed>review,code:failed>design,review:approved>verify,review:rejected>code,verify:approved>COMPLETE,verify:rejected>code" \
  [--description "説明"] \
  [--priority N] \
  [--depends-on ID1,ID2] \
  [--max-iterations N]
```

- `--phases` は必須。`name:type` のカンマ区切りで指定する。
- `--transitions` は必須。`phase:condition>target` のカンマ区切りで指定する。
- `--depends-on` で依存ジョブを指定できる。循環依存はエラーになる。
- `--max-iterations` でイテレーション上限を設定（デフォルト: 10）。上限到達時はフェーズが進まず一時停止（pause with reason: max_iterations）する。

### ジョブの一覧

```bash
ccsquad job list
```

### ジョブの詳細表示

```bash
ccsquad job show <ID>
ccsquad job show <ID> --format json
```

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

- review フェーズでは使用不可（`approve`/`reject` を使う）。
- 対応する遷移ルールがなければエラー。

### レビュー承認/却下

```bash
ccsquad job approve <ID> [--message "メッセージ"]
ccsquad job reject <ID> --message "却下理由"
```

- review フェーズでのみ使用可。

### ジョブの中断

```bash
ccsquad job abort <ID>
```

- `pending` または `running` のジョブを `aborted` にする。

## 受入基準（Acceptance Criteria）の運用

ジョブの body には `## Acceptance Criteria` セクションを必ず含める。
これにより「何をもって完了とするか」を実装前に合意し、レビューの判断基準を明確にする。

### タイミング

- **ジョブ作成時**: `--description` に初期の受入基準を含める。この時点では粗い粒度でよい。
- **plan フェーズ完了時**: 受入基準を具体的なチェックリストに更新してから transition する。execute フェーズに入る前に基準が曖昧なままであってはならない。

### フォーマット

ジョブ body に以下の形式で記載する:

```markdown
## Acceptance Criteria

- [ ] 基準1: 具体的な完了条件
- [ ] 基準2: 具体的な完了条件
- [ ] 基準3: 具体的な完了条件
```

### ルール

- execute フェーズに遷移する前に、`## Acceptance Criteria` が具体的に定義されていること。
- review フェーズでは Acceptance Criteria の各項目を検証し、すべて満たされていることを確認する。
- reject 時は、どの基準が未達かを `--message` に明記する。

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
status: running
current_phase: code
iteration: 2
max_iterations: 10
priority: 5
depends_on: [J000001, J000002]
created_at: 2026-03-24T09:00:00Z
updated_at: 2026-03-24T11:00:00Z
---
## 説明
JWT ベースの認証機能を実装する。

## Acceptance Criteria

- [ ] POST /auth/login でJWTトークンを返す
- [ ] トークンの有効期限が設定されている
- [ ] 認証ミドルウェアが保護エンドポイントに適用されている
- [ ] 無効なトークンで401が返る

## Workflow

- research: plan -> completed:design, failed:ABORT
- design: plan -> completed:code, failed:ABORT
- code: execute -> completed:review, failed:design
- review: review -> approved:verify, rejected:code
- verify: review -> approved:COMPLETE, rejected:code

## フェーズログ
### research (completed → design) - 2026-03-24T09:30:00Z
調査完了。
### design (completed → code) - 2026-03-24T10:00:00Z
設計完了。
```
