# ハーネス設計ガイド

ccsquad は、長時間タスクで起きやすいコンテキスト劣化と自己評価バイアスを、状態遷移とフェーズ分離で抑えるための CLI である。

## 解決したい問題

LLM エージェントの長時間タスクには、主に 2 つの構造的な失敗要因がある。

1. コンテキスト劣化: ウィンドウが埋まるにつれ一貫性が失われ、制限に近づくと作業を打ち切りやすくなる。
2. 自己評価バイアス: 自分が生成した成果物を自分で評価すると、品質が不十分でも肯定的に判断しやすい。

ccsquad は、タスクを `plan` / `execute` / `review` のようなフェーズに分割し、フェーズごとの成果とログを永続化することで、この問題に対処する。

## 設計原則

### 1. Generator-Evaluator 分離

実装と評価は別フェーズで行う。

- `execute` フェーズ: 実装する
- `review` フェーズ: Acceptance Criteria を検証する
- `review` はデフォルトで一時停止し、人間レビューを要求する
- `auto: true` を指定すると、自動レビュー用プロンプトを生成して継続できる

### 2. コンテキストリセット

圧縮された会話履歴に頼らず、ジョブファイルとログだけで次フェーズに引き継げる状態を作る。

- `acceptance_criteria`: 何を満たせば完了か
- `.ccsquad/logs/{jobId}.md`: 各フェーズで何が起きたか
- `ccsquad prompt <id>`: 現在フェーズに必要な情報だけを再構成する

### 3. スプリント契約

`execute` に入る前に、完了条件を Acceptance Criteria として明文化する。

```bash
ccsquad update J000001 --ac '[
  {"description":"テストが通ること"},
  {"description":"README に使い方が記載されていること"}
]'
```

曖昧なまま実装に入ると、レビューと再実装のループが収束しにくくなる。

### 4. 反復による品質収束

1 回で完璧を狙うのではなく、`rejected -> execute` のループで品質を上げる。

- reject 時は未達の AC と改善指示を `--message` に書く
- `--max-iterations` で無限ループを防ぐ
- 必要に応じて `failed` や `abort` で人間判断に戻す

### 5. シンプルなワークフローから始める

フェーズは必要なときだけ増やす。複雑なハーネスは運用負荷も増やす。

| タスクの特性 | 推奨パターン |
|---|---|
| スコープが明確、小から中規模 | `basic`: plan -> execute -> review |
| 計画が不要な単純作業 | `simple`: execute -> review |
| 自動レビューまで一気通貫したい | `develop`: plan -> execute -> review(auto) |
| 計画だけ人間が承認し、以降は自動化したい | `gated`: plan -> gate(human) -> execute -> review(auto) |
| 未知の技術や広い調査が必要 | カスタム workflow で調査フェーズを追加 |

## カスタムワークフロー例

```yaml
research:
  type: plan
  agent: researcher
  on:
    completed: design
    failed: ABORT
design:
  type: plan
  agent: developer
  on:
    completed: execute
    failed: research
execute:
  type: execute
  agent: developer
  on:
    completed: review
    failed: design
review:
  type: review
  agent: reviewer
  on:
    approved: COMPLETE
    rejected: execute
```

```bash
ccsquad create "大きめの機能追加" --workflow workflow.yaml
```
