---
name: memory
description: |
  ccsquad CLI を使ったメモリエントリの管理。
  プロジェクト固有の知識・決定事項・メモをファイルベースで保存・検索・編集・削除する。
  ユーザーが「覚えておいて」「メモして」「記録して」と依頼した場合や、
  過去の決定事項・ナレッジを参照・検索したい場合にこのスキルを使用する。
---

# ccsquad memory スキル

ccsquad CLI のメモリ管理機能を操作するスキル。プロジェクト固有の知識をファイルベースで永続化する。

## 前提条件

- `ccsquad` CLI バイナリがパスに存在すること

## ストレージ構造

エントリは `.ccsquad/memory/entries/` 配下に YAML frontmatter + Markdown body として保存される。

- タイプなし: `.ccsquad/memory/entries/{title}.md`
- タイプあり: `.ccsquad/memory/entries/{type}/{title}.md`
- キー形式: `title`（タイプなし）または `type/title`（タイプあり）

## CLI コマンド

### エントリの追加

```bash
ccsquad memory add "タイトル" ["本文"] [--type <TYPE>] [--file <PATH>]
```

- `--type` でカテゴリを付与できる（例: `decision`, `note`, `architecture`, `convention`）
- 本文は位置引数、`--file`、stdin の優先順位で解決される（`--file` が最優先）
- 同名エントリが既に存在する場合はエラーになる（`edit` を使う）

### エントリの一覧

```bash
ccsquad memory list [--type <TYPE>] [--format text|json]
```

- `--type` で特定タイプのエントリのみ表示
- `--format json` でマシンリーダブルな出力を得られる

### エントリの詳細表示

```bash
ccsquad memory show <KEY> [--format text|json]
```

- キーは `title` または `type/title` の形式
- `--format json` で JSON 出力（key, title, type, body, created_at, updated_at を含む）

### エントリの編集

```bash
ccsquad memory edit <KEY> [--title "新タイトル"] [--type <TYPE>] [--no-type] ["新本文"] [--file <PATH>]
```

- `--title` でタイトルを変更（キーも変わる）
- `--type` でタイプを変更、`--no-type` でタイプを削除
- 本文は位置引数または `--file` で指定（省略時は既存の本文を維持）

### エントリの削除

```bash
ccsquad memory delete <KEY>
```

### エントリの検索

```bash
ccsquad memory search "クエリ" [--type <TYPE>] [--format text|json]
```

- タイトルと本文を対象にした全文検索
- `--type` でタイプを絞り込める

## 推奨タイプ

エントリのタイプは自由に設定できるが、以下を推奨する:

| タイプ | 用途 |
|---|---|
| `decision` | 設計・技術的な意思決定の記録 |
| `convention` | コーディング規約・命名規則 |
| `architecture` | アーキテクチャに関するメモ |
| `note` | その他の汎用メモ |
| `todo` | 将来対応が必要な事項 |
| `incident` | 障害・問題の記録 |

## 使い方のガイドライン

### 保存すべき情報

- コードやコミット履歴から読み取れない意思決定の「理由」
- プロジェクト固有の規約やルール
- 外部リソースへの参照（URL、チケット番号など）
- 将来の作業に影響する制約や前提条件

### 保存すべきでない情報

- コードを読めばわかること（ファイル構造、関数名など）
- git log で追えること（変更履歴、誰が何を変えたか）
- 一時的な作業状態（現在のデバッグ状況など）

### 操作の流れ

1. **記録する前に検索**: 既存エントリと重複しないか `search` で確認
2. **適切なタイプを付与**: 後から検索しやすくするため
3. **古い情報は更新**: `edit` で最新の状態に保つ
4. **不要になったら削除**: `delete` で整理する
