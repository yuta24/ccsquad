---
name: optimize
description: |
  メトリクス駆動のワークフロー最適化スキル。
  複数ジョブのメトリクスを横断分析し、ワークフローやパラメータの改善を提案する。
  ユーザーが「最適化して」「ワークフローを改善して」「パフォーマンスを分析して」と依頼した場合に使用する。
---

# ワークフロー最適化スキル

蓄積されたジョブメトリクスを横断分析し、ワークフロー設計の改善パターンを検出する。

## CLI コマンド

```bash
# 横断分析レポート
ccsquad optimize analyze
ccsquad optimize analyze --format json
ccsquad optimize analyze --status completed,failed

# 改善提案の出力
ccsquad optimize suggest
ccsquad optimize suggest --format json
ccsquad optimize suggest --status completed
```

## 実行フロー

### 1. メトリクスの収集と分析

```bash
ccsquad optimize analyze --format json
```

全ジョブ（デフォルト: completed, failed, aborted）のメトリクスを横断分析する。

検出パターン:
- **high_reject_rate**: 全体のリジェクト率が高い
- **iteration_overflow**: 多くのジョブがイテレーション上限付近に到達
- **short_plan_high_reject**: plan 時間が短く（< 10%）リジェクト率が高い相関
- **long_phase**: 特定フェーズが全体時間の 60% 以上を占有

### 2. 改善提案の取得

```bash
ccsquad optimize suggest --format json
```

### 3. 深掘り分析（エージェントが実施）

CLI の分析結果を踏まえ、以下を検討する:

- **ワークフローテンプレートの改善**: フェーズ追加・分割、遷移ルールの見直し
- **パラメータ調整**: max_iterations のデフォルト値、auto レビューの適用判断
- **エージェント定義の改善**: reject パターンに基づくプロンプト改善
- **タスク粒度の見直し**: 大きすぎるタスクの分割基準

### 4. 過去の振り返りとの統合

`.ccsquad/retrospectives/` に保存された個別ジョブの振り返りも参照し、
横断分析の結果と照合して提案を補強する。

```bash
ccsquad retro list --format json
```

### 5. 改善の適用

提案内容をユーザーに提示し、承認後に適用する。
適用対象:
- ワークフローテンプレート（`--workflow` のデフォルト値）
- エージェント定義（`.claude/agents/*.md`）
- ジョブのデフォルトパラメータ（`max_iterations` 等）

## 分析対象のフィルタリング

`--status` オプションで分析対象を絞り込める:
- `completed`: 成功したジョブのみ
- `failed,aborted`: 失敗・中断したジョブのみ
- デフォルト: `completed,failed,aborted`（全終了ジョブ）
