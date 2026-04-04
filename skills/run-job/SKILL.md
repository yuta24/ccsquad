---
name: run-job
description: |
  ジョブを自動実行するオーケストレーションスキル。
  フェーズタイプに応じてエージェントを起動し、結果に基づいて遷移を実行する。
  review フェーズでは一時停止し、人間の判断を待つ。
  ユーザーが「ジョブを実行して」「ジョブを回して」と依頼した場合に使用する。
---

# ジョブ自動実行スキル

ジョブIDを受け取り、フェーズタイプに応じたエージェントを起動しながらワークフローを自動進行する。

## 実行ループ

```
┌─ Step 1: ccsquad job show <ID> --format json
│    ├─ pending → ccsquad job run <ID> → Step 2
│    ├─ running → Step 2
│    ├─ paused → Step 5（人間レビュー待ち or max_iterations）
│    └─ completed/failed/aborted → 報告して終了
│
├─ Step 2: phase_config を判定
│    ├─ type が review かつ auto が false → Step 5（人間レビュー）
│    ├─ type が review かつ auto が true → Step 3 または Step 4（自動レビュー）
│    ├─ phase_config.agent がある場合 → Step 3（単一エージェント）
│    └─ phase_config.agents がある場合 → Step 4（並列マルチエージェント）
│
├─ Step 3: 単一エージェント実行
│    │  phase_config.agent のエージェントを起動
│    │  結果 (completed/failed) を受け取る
│    └─ ccsquad job transition <ID> <result> --message "..."
│         ├─ 「ジョブが完了/失敗しました」→ 報告して終了
│         ├─ 「フェーズを遷移しました」→ Step 1 に戻る
│         ├─ 「一時停止」(human_review) → Step 5
│         └─ 「一時停止」(max_iterations) → 上限到達を報告して終了
│
├─ Step 4: 並列マルチエージェント実行
│    │  phase_config.agents の各エントリをサブエージェントとして並列起動
│    │  （Agent ツールを複数同時に呼び出す）
│    │  各エージェントに constraint がある場合、追加指示として渡す
│    │  全サブエージェントの完了を待つ
│    │  集約ルール: 全完了 → completed、いずれか失敗 → failed
│    └─ ccsquad job transition <ID> <result> --message "..."
│         ├─ 「ジョブが完了/失敗しました」→ 報告して終了
│         ├─ 「フェーズを遷移しました」→ Step 1 に戻る
│         ├─ 「一時停止」(human_review) → Step 5
│         └─ 「一時停止」(max_iterations) → 上限到達を報告して終了
│
└─ Step 5: review フェーズ到達 → ユーザーに報告して停止
```

## エージェントのプロンプト

### 単一エージェント（phase_config.agent）

`phase_config.agent` の値（例: developer, planner, explorer）に対応する `.claude/agents/{agent}.md` のエージェントを起動する。

```
以下のジョブの「{current_phase}」フェーズ（タイプ: {phase_type}、エージェント: {agent}）を実行してください。

## ジョブ情報
- ID: {id}
- タイトル: {title}
- イテレーション: {iteration}/{max_iterations}

## ジョブ body
{body 全文}

## 指示
- plan フェーズ: 調査・設計を行い、Acceptance Criteria を具体化する
- execute フェーズ: Acceptance Criteria に基づいて実装・テストを行う
- 結果を { result: "completed"|"failed", message: "要約" } で返す
```

### 並列マルチエージェント（phase_config.agents）

`phase_config.agents` の各エントリに対して Agent ツールを **並列** で起動する。

```
以下のジョブの「{current_phase}」フェーズ（タイプ: {phase_type}、エージェント: {agent}）を実行してください。

## ジョブ情報
- ID: {id}
- タイトル: {title}
- イテレーション: {iteration}/{max_iterations}

## ジョブ body
{body 全文}

{constraint がある場合:}
## 追加制約
{constraint}

## 指示
- plan フェーズ: 調査・設計を行い、Acceptance Criteria を具体化する
- execute フェーズ: Acceptance Criteria に基づいて実装・テストを行う
- 結果を { result: "completed"|"failed", message: "要約" } で返す
```

**集約ルール**: 全エージェントが completed → completed、いずれかが failed → failed

## review 到達時の報告

```
ジョブ {ID} が review フェーズ「{current_phase}」に到達しました。

レビュー後、以下のいずれかを実行してください:
  ccsquad job transition {ID} approved --message "承認理由"
  ccsquad job transition {ID} rejected --message "却下理由（どの基準が未達か明記）"
```

## ルール

1. **review は自動実行しない** — Generator-Evaluator 分離。自動化するとハーネスの意味がなくなる
2. **毎ステップ `job show` で最新状態を取得** — 前ステップの記憶に頼らない（コンテキストリセット）
3. **body 全文をエージェントに渡す** — body がハンドオフ情報。省略しない
4. **遷移は CLI 経由** — ジョブファイルを直接編集しない
5. **迷ったら停止** — 自動化の暴走はハーネスが防ぐべきリスク
