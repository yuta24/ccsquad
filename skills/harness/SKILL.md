---
name: harness
description: |
  ccsquad を使ったハーネス設計の原則とワークフロー構成の判断基準。
  長時間実行タスクの品質を担保するための設計パターンを提供する。
  新しいジョブのワークフローを設計する際や、既存ワークフローの改善を
  検討する際にこのスキルを参照する。
---

# ハーネス設計スキル

ccsquad を使った長時間実行タスクのハーネス設計ガイド。
ワークフローの構成判断・品質担保の仕組みを体系的にまとめる。

## ハーネスの目的

LLM エージェントが長時間タスクを実行する際、以下の2つの障害が品質を劣化させる:

1. **コンテキスト劣化** — コンテキストウィンドウが埋まるにつれ一貫性が失われる。さらに「コンテキスト不安症」により、制限に近づくと作業を途中で打ち切る傾向がある。
2. **自己評価バイアス** — 自分が生成した成果物を評価させると、品質が平凡でも肯定的に評価してしまう。

ハーネスはこれらの障害に対処し、エージェントが長時間タスクでも安定した品質を維持できるよう構造的に支援する仕組みである。

## 設計原則

### 1. Generator-Evaluator 分離

実装（Generator）と評価（Evaluator）は別のコンテキストで行う。
自己評価バイアスを排除し、客観的な品質判断を可能にする。

**ccsquad での実現:**
- `execute` フェーズ = Generator（実装を行う）
- `review` フェーズ = Evaluator（実装を評価する）
- review フェーズは常に一時停止し、別コンテキスト（人間または別エージェント）で評価する

### 2. コンテキストリセット

圧縮（同一コンテキスト内での要約）ではなく、リセット（コンテキストを完全にクリア）+構造化ハンドオフで品質を維持する。

**ccsquad での実現:**
- フェーズ遷移のたびにコンテキストがリセットされる前提で設計する
- ハンドオフ情報はジョブ body に永続化する:
  - `## Acceptance Criteria` — 完了基準（何を達成すべきか）
  - `## フェーズログ` — 各フェーズの成果と判断の記録（何が起きたか）
- 次のフェーズのエージェントは body を読むだけで作業を継続できる状態にする

### 3. スプリント契約（事前合意）

execute フェーズに入る前に「何をもって完了とするか」を合意する。
曖昧なまま実装に入ると、評価基準がぶれてループが収束しない。

**ccsquad での実現:**
- plan フェーズで `## Acceptance Criteria` を具体的なチェックリストとして定義する
- execute フェーズに遷移する前に基準が確定していること
- review フェーズでは Acceptance Criteria の各項目を検証する
- 詳細は job スキルの「受入基準（Acceptance Criteria）の運用」セクションを参照

### 4. 反復による品質収束

review で rejected → execute に戻すループにより、品質を段階的に収束させる。
1回の実装で完璧を求めるのではなく、反復で品質を高める設計にする。

**ccsquad での実現:**
- review の rejected 遷移先を execute（または plan）に設定する
- `--max-iterations` で無限ループを防止する（デフォルト: 10）
- max_iterations 到達時は pause し、人間が判断する
- reject 時は `--message` でどの基準が未達かを明記し、次の反復の指針とする

### 5. モデル進化に伴う再評価

ハーネスの各コンポーネントは「モデルにできないこと」の仮定をエンコードしている。
モデルが改善されたら、その仮定が今も正しいか再評価する。

**判断基準:**
- パフォーマンスに寄与していないフェーズは削除を検討する
- モデルの改善により新たに可能になったアプローチを取り入れる
- 原則: シンプルに始めて、必要な場合のみ複雑さを追加する

## 標準ワークフローパターン

### 基本パターン: plan → execute → review

最も基本的な構成。ほとんどのタスクはこのパターンで対応できる。

```bash
ccsquad job add "タスク名" \
  --phases "plan:plan,code:execute,review:review" \
  --transitions "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>COMPLETE,review:rejected>code"
```

```
plan ──completed──> code ──completed──> review ──approved──> COMPLETE
  ^                  |                    |
  └───failed─────────┘                   │
  ^                                       │
  └──────────────rejected─────────────────┘
```

- plan: スコープ確定 + Acceptance Criteria 定義
- code: 実装
- review: Acceptance Criteria に基づく評価
- rejected → code に戻してループ（code:failed → plan に戻すことで再計画も可能）

### 拡張パターン: 調査分離

調査と設計を分離し、plan フェーズを段階的に進める。未知の領域が多いタスク向け。

```bash
ccsquad job add "タスク名" \
  --phases "research:plan,design:plan,code:execute,review:review" \
  --transitions "research:completed>design,research:failed>ABORT,design:completed>code,design:failed>ABORT,code:completed>review,code:failed>design,review:approved>COMPLETE,review:rejected>code"
```

- research: 技術調査・制約の洗い出し
- design: 設計判断 + Acceptance Criteria 定義
- code → review は基本パターンと同じ

### 拡張パターン: 二段階レビュー

コードレビューと動作確認を分離する。品質要求が高いタスク向け。

```bash
ccsquad job add "タスク名" \
  --phases "plan:plan,code:execute,review:review,verify:review" \
  --transitions "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>verify,review:rejected>code,verify:approved>COMPLETE,verify:rejected>code"
```

- review: コードレビュー（設計・実装品質の評価）
- verify: 動作確認（Acceptance Criteria の項目検証）

## ワークフロー選択の指針

| タスクの特性 | 推奨パターン |
|---|---|
| スコープが明確、小〜中規模 | 基本パターン |
| 未知の技術・ドメインを含む | 調査分離パターン |
| 品質要求が高い、リリース直前 | 二段階レビューパターン |

迷った場合は基本パターンから始め、必要に応じてフェーズを追加する。
