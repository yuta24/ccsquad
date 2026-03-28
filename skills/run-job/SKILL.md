---
name: run-job
description: |
  ジョブを自動実行するオーケストレーションスキル。
  フェーズタイプに応じてエージェントを起動し、結果に基づいて遷移を実行する。
  review フェーズでは一時停止し、人間の判断を待つ。
  ユーザーが「ジョブを実行して」「ジョブを回して」と依頼した場合に使用する。
---

# ジョブ自動実行スキル

ジョブIDを受け取り、フェーズタイプに応じたエージェントを起動しながら自動的にワークフローを進行する。

## 前提条件

- `ccsquad` CLI バイナリがパスに存在すること
- 対象ジョブが作成済みであること

## 実行手順

以下の手順を **厳密に順序どおり** 実行すること。ステップを飛ばしたり順序を変えてはならない。

### Step 1: ジョブの状態確認

```bash
ccsquad job show <ID> --format json
```

出力の `status` に応じて分岐する:

- `pending` → `ccsquad job run <ID>` で開始してから Step 2 へ
- `running` → そのまま Step 2 へ
- `completed` → 「ジョブは既に完了しています」と報告して **終了**
- `failed` / `aborted` → 「ジョブは既に終了しています (status: {status})」と報告して **終了**

### Step 2: 現フェーズの情報取得

```bash
ccsquad job show <ID> --format json
```

出力から以下を取得する:

- `current_phase` — 現在のフェーズ名
- `phase_config.type` — フェーズタイプ (`plan` / `execute` / `review`)
- `body` — ジョブ body 全文

### Step 3: フェーズタイプに応じた処理

#### `plan` または `execute` の場合 → エージェント起動

Agent tool で **coder サブエージェント** を起動する。プロンプトは以下のテンプレートを使う:

```
以下のジョブの「{current_phase}」フェーズ（タイプ: {phase_config.type}）を実行してください。

## ジョブ情報
- ID: {id}
- タイトル: {title}
- イテレーション: {iteration}/{max_iterations}

## ジョブ body
{body の全文}

## 指示
- ジョブ body の「説明」と「Acceptance Criteria」を確認し、このフェーズで行うべき作業を実行すること
- plan フェーズの場合: 調査・設計を行い、Acceptance Criteria を具体的なチェックリストに更新すること
- execute フェーズの場合: Acceptance Criteria に基づいて実装・テストを行うこと
- 作業完了後、以下の形式で結果を返すこと:
  - result: completed または failed
  - message: 作業内容の要約、または失敗理由
```

エージェントの返却値から `result` と `message` を読み取り、Step 4 へ進む。

#### `review` の場合 → 一時停止

**エージェントを起動せず、ユーザーに報告して停止する。**

報告内容:

```
ジョブ {ID} が review フェーズ「{current_phase}」に到達しました。

レビュー後、以下のいずれかを実行してください:
  ccsquad job approve {ID} --message "承認理由"
  ccsquad job reject {ID} --message "却下理由（どの基準が未達か明記）"

または /run-job {ID} で続行できます（approve/reject 実行後）。
```

**ここで手順を終了する。** ユーザーが approve/reject を実行するまで先に進まない。

### Step 4: 遷移の実行

Step 3 のエージェント結果に基づいて遷移コマンドを実行する:

- result が `completed` の場合:
  ```bash
  ccsquad job transition <ID> completed --message "{message}"
  ```
- result が `failed` の場合:
  ```bash
  ccsquad job transition <ID> failed --message "{message}"
  ```
- result が上記以外、または判別できない場合:
  ```bash
  ccsquad job transition <ID> failed --message "エージェントの結果を解析できませんでした"
  ```

### Step 5: 遷移結果の判定

遷移コマンドの出力を確認し、分岐する:

- **「ジョブが完了しました」** → 完了を報告して **終了**
- **「ジョブが失敗しました」** → 失敗を報告して **終了**
- **「フェーズを遷移しました」** → Step 2 に戻る
- **「一時停止」(reason: human_review)** → review フェーズ到達。Step 3 の review 手順に従い **停止**
- **「一時停止」(reason: max_iterations)** → 以下を報告して **停止**:
  ```
  ジョブ {ID} がイテレーション上限に到達しました。
  継続する場合は手動で遷移を実行してください。
  ```

## 重要なルール

1. **review フェーズは絶対に自動実行しない** — Generator-Evaluator 分離の原則。review を自動化するとハーネスの存在意義がなくなる
2. **毎回 `ccsquad job show` で最新状態を取得する** — コンテキストリセットの原則。前のステップの記憶に頼らない
3. **エージェントにはジョブ body 全文を渡す** — body が次フェーズへのハンドオフ情報。省略しない
4. **遷移は必ず ccsquad CLI 経由で行う** — ジョブファイルを直接編集しない。CLI が状態整合性を保証する
5. **判断に迷ったら停止してユーザーに確認する** — 自動化の暴走はハーネスが防ぐべきリスクそのもの
