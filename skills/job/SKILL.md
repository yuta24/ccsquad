---
name: job
description: |
  ccsquad CLI を使ったジョブ管理とステートマシン型ワークフローの操作。
  ジョブの作成・更新・一覧・状態確認・フェーズ遷移・レビュー承認/却下・中断を行う。
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

## ワークフローテンプレート

### レビュー方式の選び方

| 条件 | 方式 | フェーズ定義 |
|------|------|-------------|
| 品質や安全性が重要、本番に影響する変更 | **人間レビュー**（デフォルト） | `review:review:reviewer` |
| 定型的な修正、リスクが低い変更 | **自動レビュー** | `review:review:reviewer:auto` |

- **デフォルトは人間レビュー**。`:auto` を付けない限り review フェーズで一時停止し、人間が `job approve` / `job reject` で判断する
- review フェーズでも **agent 指定は必須**（`:auto` 時にエージェントが実行する。人間レビュー時は使われないが構文上必要）
- 迷ったら人間レビューを選ぶ。自動化の暴走防止がハーネスの本質的な価値

### 基本パターン: plan → execute → review（人間レビュー）

スコープが明確な小〜中規模タスク向け。迷ったらこれから始める。
review フェーズで一時停止し、人間が承認/却下を判断する。

```bash
ccsquad job add "タスク名" \
  --phases "plan:plan:developer,code:execute:developer,review:review:reviewer" \
  --transitions "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>COMPLETE,review:rejected>code"
```

### 自動レビューパターン: plan → execute → auto review

reviewer エージェントによる自動レビュー。リスクが低く人間の確認が不要な場合のみ使用。

```bash
ccsquad job add "タスク名" \
  --phases "plan:plan:developer,code:execute:developer,review:review:reviewer:auto" \
  --transitions "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>COMPLETE,review:rejected>code"
```

### 調査分離パターン: research → design → execute → review（人間レビュー）

未知の技術・ドメインを含むタスク向け。調査と設計を分離する。

```bash
ccsquad job add "タスク名" \
  --phases "research:plan:developer,design:plan:developer,code:execute:developer,review:review:reviewer" \
  --transitions "research:completed>design,research:failed>ABORT,design:completed>code,design:failed>ABORT,code:completed>review,code:failed>design,review:approved>COMPLETE,review:rejected>code"
```

### 二段階レビューパターン: plan → execute → review → verify（人間レビュー）

品質要求が高いタスク向け。コードレビューと動作確認を分離する。

```bash
ccsquad job add "タスク名" \
  --phases "plan:plan:developer,code:execute:developer,review:review:reviewer,verify:review:reviewer" \
  --transitions "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>verify,review:rejected>code,verify:approved>COMPLETE,verify:rejected>code"
```

### 並列探索パターン: explore(並列) → design → execute → review（人間レビュー）

大規模タスクや複数の設計選択肢があるタスク向け。複数エージェントが異なる視点で並列調査し、結果を統合してから設計に進む。

`--phases` で `agent[constraint]+agent[constraint]` の形式でマルチエージェントと constraint を指定できる。

```bash
ccsquad job add "タスク名" \
  --phases "explore:plan:explorer[類似機能の実装パターンと再利用可能なコードを調査]+explorer[アーキテクチャ層・モジュール境界・抽象化パターンを調査]+explorer[テスト慣習・統合ポイント・外部依存を調査],design:plan:developer,code:execute:developer,review:review:reviewer" \
  --transitions "explore:completed>design,explore:failed>ABORT,design:completed>code,design:failed>ABORT,code:completed>review,code:failed>design,review:approved>COMPLETE,review:rejected>code"
```

constraint を省略して `explorer+explorer+explorer` とすることも可能。constraint の設計指針は `harness` スキルを参照。

## Acceptance Criteria の運用

- **plan フェーズ完了前**: `## Acceptance Criteria` を具体的なチェックリストに更新する。曖昧なまま execute に入らない
- **execute フェーズ**: Acceptance Criteria の各項目を満たす実装を行う
- **review フェーズ**: 各項目を検証し、未達なら reject 時にどの基準が未達か明記する
- execute への遷移には `## Acceptance Criteria` セクションが必須（CLI がガードする）

```markdown
## Acceptance Criteria

- [ ] 基準1: 具体的な完了条件
- [ ] 基準2: 具体的な完了条件
```

## CLI コマンド

```bash
# 作成（--phases, --transitions は必須）
ccsquad job add "タイトル" \
  --phases "name:type:agent,..." \
  --transitions "phase:condition>target,..." \
  [--description "説明"] [--priority N] [--depends-on ID1,ID2] [--max-iterations N]

# 一覧・詳細
ccsquad job list [--exclude-status completed,cancelled]
ccsquad job show <ID> [--format json]

# 実行・遷移
ccsquad job run <ID>                                    # pending → running
ccsquad job transition <ID> <completed|failed> [--message "..."]

# レビュー（review フェーズのみ）
ccsquad job approve <ID> [--message "..."]
ccsquad job reject <ID> --message "却下理由"

# 更新
ccsquad job update <ID> [--title "新タイトル"] [--priority N] [--description "説明"]
cat long_desc.md | ccsquad job update <ID> --description -   # stdin から長文読み込み

# 中断
ccsquad job abort <ID>

# サマリー
ccsquad job summary <ID> [--format json]
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
pending → running (最初のフェーズ) → running (次のフェーズ) → ... → completed/failed
                                                                    ↑
abort ─────────────────────────────────────────────────────────> aborted
```

終了したジョブ（completed/failed/aborted）は再実行できない。
