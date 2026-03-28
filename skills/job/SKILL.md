---
name: job
description: |
  ccsquad CLI を使ったジョブ管理とステートマシン型ワークフローの操作。
  ジョブの作成・一覧・状態確認・フェーズ遷移・レビュー承認/却下・中断を行う。
  ユーザーがジョブやワークフローの操作を依頼した場合、またはタスクの進行管理が
  必要な場合にこのスキルを使用する。
---

# ジョブ管理スキル

## ワークフローテンプレート

### 基本パターン: plan → execute → review

スコープが明確な小〜中規模タスク向け。迷ったらこれから始める。

```bash
ccsquad job add "タスク名" \
  --phases "plan:plan,code:execute,review:review" \
  --transitions "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>COMPLETE,review:rejected>code"
```

### 調査分離パターン: research → design → execute → review

未知の技術・ドメインを含むタスク向け。調査と設計を分離する。

```bash
ccsquad job add "タスク名" \
  --phases "research:plan,design:plan,code:execute,review:review" \
  --transitions "research:completed>design,research:failed>ABORT,design:completed>code,design:failed>ABORT,code:completed>review,code:failed>design,review:approved>COMPLETE,review:rejected>code"
```

### 二段階レビューパターン: plan → execute → review → verify

品質要求が高いタスク向け。コードレビューと動作確認を分離する。

```bash
ccsquad job add "タスク名" \
  --phases "plan:plan,code:execute,review:review,verify:review" \
  --transitions "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>verify,review:rejected>code,verify:approved>COMPLETE,verify:rejected>code"
```

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
  --phases "name:type,..." \
  --transitions "phase:condition>target,..." \
  [--description "説明"] [--priority N] [--depends-on ID1,ID2] [--max-iterations N]

# 一覧・詳細
ccsquad job list
ccsquad job show <ID> [--format json]

# 実行・遷移
ccsquad job run <ID>                                    # pending → running
ccsquad job transition <ID> <completed|failed> [--message "..."]

# レビュー（review フェーズのみ）
ccsquad job approve <ID> [--message "..."]
ccsquad job reject <ID> --message "却下理由"

# 中断
ccsquad job abort <ID>

# サマリー
ccsquad job summary <ID> [--format json]
```

## ライフサイクル

```
pending → running (最初のフェーズ) → running (次のフェーズ) → ... → completed/failed
                                                                    ↑
abort ─────────────────────────────────────────────────────────> aborted
```

終了したジョブ（completed/failed/aborted）は再実行できない。
