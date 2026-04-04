---
name: job
description: |
  ccsquad CLI を使ったジョブ管理とステートマシン型ワークフローの操作。
  ジョブの作成・更新・一覧・状態確認・フェーズ遷移・中断を行う。
  ユーザーがジョブやワークフローの操作を依頼した場合、またはタスクの進行管理が
  必要な場合にこのスキルを使用する。
---

# ジョブ管理スキル

## ワークフロー作成の前提

ジョブを作成する前に、プロジェクトの `.claude/agents/` ディレクトリを確認し、利用可能なエージェント一覧を把握すること。

```bash
ls .claude/agents/
```

エージェント一覧に基づいて、タスクに最適なワークフローを組み立てる。例えば:
- `explorer.md` が存在する場合、調査フェーズで explorer を活用できる
- カスタムエージェントが存在する場合、対応するフェーズに割り当てる
- エージェント指定は必須。省略するとエラーになる

## ワークフロー定義

ワークフローはジョブの frontmatter に YAML で保存される。定義方法は2通り:

### 方法1: `--workflow` オプション（推奨）

JSON/YAML 文字列、ファイルパス、または stdin からワークフロー定義を渡す。
エージェントが動的にワークフローを組み立てる場合に最適。

```bash
# JSON 文字列で指定
ccsquad job add "タスク名" --workflow '{
  "plan": {"type":"plan","agent":"developer","on":{"completed":"code","failed":"ABORT"}},
  "code": {"type":"execute","agent":"developer","on":{"completed":"review","failed":"plan"}},
  "review": {"type":"review","agent":"reviewer","on":{"approved":"COMPLETE","rejected":"code"}}
}'

# YAML ファイルで指定
ccsquad job add "タスク名" --workflow workflow.yaml

# stdin から読み込み
cat workflow.yaml | ccsquad job add "タスク名" --workflow -
```

### 方法2: `--phases` + `--transitions` オプション

インラインでフェーズと遷移ルールを個別に指定する。

```bash
ccsquad job add "タスク名" \
  --phases "plan:plan:developer,code:execute:developer,review:review:reviewer" \
  --transitions "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>COMPLETE,review:rejected>code"
```

`--workflow` と `--phases/--transitions` は排他。同時指定はエラーになる。

## レビュー方式の選び方

| 条件 | 方式 | 設定 |
|------|------|------|
| 品質や安全性が重要、本番に影響する変更 | **人間レビュー**（デフォルト） | `auto` なし |
| 定型的な修正、リスクが低い変更 | **自動レビュー** | `"auto": true` |

- **デフォルトは人間レビュー**。`auto: true` を付けない限り review フェーズで一時停止（status: paused）し、人間が `job transition <ID> approved` / `job transition <ID> rejected` で判断する
- review フェーズでも **agent 指定は必須**（`auto` 時にエージェントが実行する。人間レビュー時は使われないが構文上必要）
- 迷ったら人間レビューを選ぶ。自動化の暴走防止がハーネスの本質的な価値

## ワークフローテンプレート

### 基本パターン: plan → execute → review（人間レビュー）

スコープが明確な小〜中規模タスク向け。迷ったらこれから始める。

```bash
ccsquad job add "タスク名" --workflow '{
  "plan": {"type":"plan","agent":"developer","on":{"completed":"code","failed":"ABORT"}},
  "code": {"type":"execute","agent":"developer","on":{"completed":"review","failed":"plan"}},
  "review": {"type":"review","agent":"reviewer","on":{"approved":"COMPLETE","rejected":"code"}}
}'
```

### 自動レビューパターン: plan → execute → auto review

reviewer エージェントによる自動レビュー。リスクが低く人間の確認が不要な場合のみ使用。

```bash
ccsquad job add "タスク名" --workflow '{
  "plan": {"type":"plan","agent":"developer","on":{"completed":"code","failed":"ABORT"}},
  "code": {"type":"execute","agent":"developer","on":{"completed":"review","failed":"plan"}},
  "review": {"type":"review","agent":"reviewer","auto":true,"on":{"approved":"COMPLETE","rejected":"code"}}
}'
```

### 調査分離パターン: research → design → execute → review（人間レビュー）

未知の技術・ドメインを含むタスク向け。調査と設計を分離する。

```bash
ccsquad job add "タスク名" --workflow '{
  "research": {"type":"plan","agent":"developer","on":{"completed":"design","failed":"ABORT"}},
  "design": {"type":"plan","agent":"developer","on":{"completed":"code","failed":"ABORT"}},
  "code": {"type":"execute","agent":"developer","on":{"completed":"review","failed":"design"}},
  "review": {"type":"review","agent":"reviewer","on":{"approved":"COMPLETE","rejected":"code"}}
}'
```

### 二段階レビューパターン: plan → execute → review → verify（人間レビュー）

品質要求が高いタスク向け。コードレビューと動作確認を分離する。

```bash
ccsquad job add "タスク名" --workflow '{
  "plan": {"type":"plan","agent":"developer","on":{"completed":"code","failed":"ABORT"}},
  "code": {"type":"execute","agent":"developer","on":{"completed":"review","failed":"plan"}},
  "review": {"type":"review","agent":"reviewer","on":{"approved":"verify","rejected":"code"}},
  "verify": {"type":"review","agent":"reviewer","on":{"approved":"COMPLETE","rejected":"code"}}
}'
```

### 並列探索パターン: explore(並列) → design → execute → review（人間レビュー）

大規模タスクや複数の設計選択肢があるタスク向け。複数エージェントが異なる視点で並列調査し、結果を統合してから設計に進む。

```bash
ccsquad job add "タスク名" --workflow '{
  "explore": {
    "type": "plan",
    "agents": [
      {"agent":"explorer","constraint":"類似機能の実装パターンと再利用可能なコードを調査"},
      {"agent":"explorer","constraint":"アーキテクチャ層・モジュール境界・抽象化パターンを調査"},
      {"agent":"explorer","constraint":"テスト慣習・統合ポイント・外部依存を調査"}
    ],
    "on": {"completed":"design","failed":"ABORT"}
  },
  "design": {"type":"plan","agent":"developer","on":{"completed":"code","failed":"ABORT"}},
  "code": {"type":"execute","agent":"developer","on":{"completed":"review","failed":"design"}},
  "review": {"type":"review","agent":"reviewer","on":{"approved":"COMPLETE","rejected":"code"}}
}'
```

constraint の設計指針は `harness` スキルを参照。

## Acceptance Criteria の運用

AC は frontmatter の構造化配列 `acceptance_criteria` で管理される。

- **plan フェーズ完了前**: AC を具体的な条件に更新する。曖昧なまま execute に入らない
- **execute フェーズ**: AC の各項目を満たす実装を行い、`done: true` に更新する
- **review フェーズ**: 各項目を検証し、未達なら reject 時にどの基準が未達か明記する
- execute への遷移には `acceptance_criteria` が1件以上必須（CLI がガードする）

```yaml
acceptance_criteria:
  - description: "具体的な完了条件1"
    done: false
  - description: "具体的な完了条件2"
    done: false
```

## CLI コマンド

```bash
# 作成（--workflow または --phases/--transitions のいずれか必須）
ccsquad job add "タイトル" \
  --workflow '<JSON/YAML文字列 or ファイルパス or ->' \
  [--ac '<JSON/YAML文字列 or ファイルパス or ->'] \
  [--description "説明"] [--priority N] [--depends-on ID1,ID2] [--max-iterations N]

ccsquad job add "タイトル" \
  --phases "name:type:agent,..." \
  --transitions "phase:condition>target,..." \
  [--ac '<JSON/YAML文字列 or ファイルパス or ->'] \
  [--description "説明"] [--priority N] [--depends-on ID1,ID2] [--max-iterations N]

# 一覧・詳細（show はメトリクスサマリーも含む）
ccsquad job list [--exclude-status completed,aborted]
ccsquad job show <ID> [--format json]

# 実行・遷移
ccsquad job run <ID>                                              # pending → running
ccsquad job transition <ID> <completed|failed> [--message "..."]  # agent フェーズ
ccsquad job transition <ID> <approved|rejected> [--message "..."] # review フェーズ

# 更新（--workflow は pending 時のみ、--ac はいつでも変更可能）
ccsquad job update <ID> [--title "新タイトル"] [--priority N] [--description "説明"]
ccsquad job update <ID> --workflow '<JSON/YAML文字列 or ファイルパス or ->'
ccsquad job update <ID> --ac '[{"description":"条件1","done":false}]'
ccsquad job update <ID> --ac '["条件1","条件2"]'   # 文字列配列も可（done:false で自動補完）
cat long_desc.md | ccsquad job update <ID> --description -   # stdin から長文読み込み

# 中断（pending, running, paused のいずれからも可能）
ccsquad job abort <ID>
```

## DAG 並列実行

```bash
# 指定ジョブを DAG 実行（depends_on に基づいて依存解決・並列実行）
ccsquad dag run J000001 J000002 J000003
ccsquad dag run --all                     # 全 pending ジョブ対象
ccsquad dag run J000001 --dry-run         # 実行計画のみ表示
ccsquad dag run --max-concurrency 2       # 最大並列数指定

# review 承認後のジョブ再開
ccsquad dag resume                        # running + worktree なしを自動検出
ccsquad dag resume J000001                # 指定ジョブを再開

# 実行状態の確認とクリーンアップ
ccsquad dag status [--format json]
ccsquad dag clean                         # 孤立 worktree の削除
```

## ライフサイクル

```
pending → running (agent フェーズ) ⇄ paused (review 待ち / max_iterations) → ... → completed/failed
  ↓           ↓                          ↓
  └───────── aborted ←──────────────────┘
```

- review フェーズ到達時: `running → paused` (pause_reason: human_review)
- max_iterations 到達時: `running → paused` (pause_reason: max_iterations)
- 人間が `job transition` で判断後: `paused → running`
- 終了したジョブ（completed/failed/aborted）は再実行できない
