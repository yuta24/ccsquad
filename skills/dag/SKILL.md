---
name: dag
description: |
  DAG ベースのマルチジョブ並列実行。
  depends_on に基づいてジョブをトポロジカルソートし、依存のないジョブを並列で実行する。
  各ジョブは独立した git worktree + claude セッションで実行される。
  ユーザーが「DAG 実行して」「並列で実行して」と依頼した場合に使用する。
---

# DAG マルチジョブ並列実行スキル

## 概要

複数ジョブを depends_on の依存関係に基づいて DAG（有向非巡回グラフ）として解決し、独立したジョブを並列実行する。

## CLI コマンド

```bash
# 指定ジョブを DAG 実行
ccsquad dag run J000001 J000002 J000003

# 全 pending ジョブを DAG 実行
ccsquad dag run --all

# 実行計画のみ表示（実際には実行しない）
ccsquad dag run J000001 J000002 --dry-run

# 最大並列数を指定（デフォルト: 4）
ccsquad dag run J000001 J000002 --max-concurrency 2

# 上流失敗時に下流を自動スキップしない
ccsquad dag run J000001 J000002 --no-cascade

# review 承認後のジョブ再開
ccsquad dag resume              # running かつ worktree なしのジョブを自動検出
ccsquad dag resume J000001      # 指定ジョブを再開

# 実行中のジョブ状態を表示
ccsquad dag status
ccsquad dag status --format json

# 孤立 worktree のクリーンアップ
ccsquad dag clean
```

## 実行モデル

```
dag run [ids...]
  │
  ├─ DAG 解決（トポロジカルソート）
  │    depends_on のないジョブ → 第1波（並列実行）
  │    第1波完了後に依存解決されたジョブ → 第2波...
  │
  ├─ ジョブごとに:
  │    1. ccsquad job run <ID> (pending → running)
  │    2. git worktree add .ccsquad/worktrees/<ID> -b ccsquad/<ID>
  │    3. worktree 内で claude -p でジョブ実行
  │    4. 完了後 worktree 削除（ブランチは残す）
  │
  └─ 結果サマリー
```

## 環境分離

- 各ジョブは **独立した git worktree** で実行される
- worktree のブランチ名: `ccsquad/<jobId>`（例: `ccsquad/J000001`）
- ジョブ完了後に worktree は自動削除される（ブランチは残る）
- マージは手動で行う

## 失敗時の動作

- デフォルトで **cascade abort** が有効: 上流ジョブが failed になると、依存する下流ジョブは自動スキップ
- `--no-cascade` で無効化可能（下流ジョブは依存が解決されないまま待機し続ける）
- SIGINT（Ctrl+C）で全プロセスとワークツリーをクリーンアップ

## review フェーズでの一時停止

- ジョブが review フェーズに到達すると、そのジョブの worktree とプロセスはクリーンアップされる
- 他の独立したジョブは引き続き実行される
- review 承認後は `ccsquad dag resume` で再開する（running かつ worktree なしのジョブを自動検出）
