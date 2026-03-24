---
name: job-reject
description: |
  一時停止中のジョブを却下し、差し戻し先フェーズから自動実行を再開する。
  `/job-reject <ジョブID> [理由]` で呼び出す。
---

# ジョブ却下スキル

pause フェーズで停止中のジョブを却下する。
差し戻し先フェーズが pause でなければ、自動連続実行を開始する。

## 実行手順

引数からジョブ ID と却下理由を取得する。理由がない場合はユーザーに尋ねる。

### 1. ジョブ状態の確認

```bash
ccsquad job show <ID> --format json
```

- `status` が `running` でなければエラーを報告して終了する

### 2. フェーズ遷移の実行

```bash
ccsquad job transition <ID> failed --message "<却下理由>"
```

遷移後のジョブ状態を再取得:

```bash
ccsquad job show <ID> --format json
```

- `status` が `failed` / `aborted` → 終了状態を報告して終了
- `status` が `running` → 差し戻し先フェーズに遷移済み

### 3. 差し戻し先での対応

遷移後の `current_phase` を確認する。

- 差し戻し先が `pause: true` → ユーザーに「フェーズ {phase} で待機中」と報告して終了
- 差し戻し先が `pause: false` → ステップ 4 に進む

### 4. サブエージェントの起動（差し戻し先が auto の場合）

`.ccsquad/.current-job` にジョブ ID を書き込み、差し戻し先フェーズのサブエージェントを起動する。
以降は SubagentStop hook が自動制御する。

プロンプトには job-approve スキルと同じ形式でタスク情報を注入する。
