---
name: retro
description: |
  ジョブ完了後の振り返り分析スキル。
  フェーズログとメトリクスを分析し、ワークフローやエージェントの改善点を提案する。
  ユーザーが「振り返りして」「レトロスペクティブ」「ジョブを分析して」と依頼した場合に使用する。
---

# 振り返り (Retrospective) スキル

完了・失敗・中断したジョブのフェーズログとメトリクスを分析し、改善点を自動検出する。

## CLI コマンド

```bash
# 振り返りを実行し保存
ccsquad retro run <id>
ccsquad retro run <id> --format json

# 保存済み振り返りを表示
ccsquad retro show <id>
ccsquad retro show <id> --format json

# 振り返り一覧
ccsquad retro list
ccsquad retro list --format json
```

## 実行フロー

### 1. 対象ジョブの特定

ユーザーがジョブ ID を指定した場合はそのジョブを分析する。
指定がない場合は `ccsquad retro list` で既存の振り返りを確認し、
未分析の終了ジョブを `ccsquad job list` で探す。

### 2. 機械的分析の実行

```bash
ccsquad retro run <id> --format json
```

以下のパターンを自動検出する:
- **high_reject_rate**: リジェクト率が 30% 以上（warning）/ 50% 以上（critical）
- **iteration_overflow**: イテレーション上限の 80% 以上を消費
- **plan_insufficient**: plan フェーズの時間比率が 10% 未満かつリジェクトあり
- **long_phase**: 単一フェーズが全体の 60% 以上を占有
- **fast_completion**: リジェクトなしで完了（テンプレート候補）

### 3. 深掘り分析（エージェントが実施）

CLI の機械的分析結果を踏まえ、以下を確認する:

- フェーズログの reject メッセージのパターン分析
- エージェント定義（`.claude/agents/`）の改善余地
- ワークフロー構成の最適化案
- Acceptance Criteria の具体性

### 4. 改善提案の提示

検出事項と改善提案をユーザーに提示する。
改善の適用はユーザーの承認後に行う。

## 保存先

振り返りレポートは `.ccsquad/retrospectives/<jobId>.md` に保存される。
過去の振り返りは `ccsquad retro list` で一覧確認できる。
