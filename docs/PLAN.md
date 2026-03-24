# ccsquad 実装計画

## Context

ccguild の設計を見直した結果、TUI・PTY管理・Hook システム・オーケストレーターは Claude Code の標準機能（サブエージェント、skill、worktree）で代替可能と判断。ccguild 固有の価値である**ジョブ管理 + ステートマシン型ワークフローエンジン**と、新たに追加する**メモリ管理 + 全文検索**を独立した CLI ツールとして再設計する。

**言語選定**: Rust。日本語全文検索の品質（tantivy + lindera）と言語の堅牢性を重視。ccguild のコード流用はせず、ゼロから実装する。ccguild の設計は参考にするが、コードはコピーしない。

## Workspace 構成

```
ccsquad/
├── Cargo.toml                     # workspace root
├── ccsquad.yaml                   # 設定例
├── crates/
│   ├── ccsquad-core/              # 共通ライブラリ
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── error.rs           # 統一エラー型
│   │       └── frontmatter.rs     # YAML frontmatter パース/書き出し
│   ├── ccsquad-jobs/              # ジョブ管理ライブラリ
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── config.rs          # SquadConfig + WorkflowConfig
│   │       ├── job.rs             # Job, JobStore, JobStatus
│   │       └── engine.rs          # WorkflowEngine (ステートマシン実行)
│   ├── ccsquad-memory/            # メモリ管理ライブラリ
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── entry.rs           # MemoryEntry, EntryStore
│   │       ├── index.rs           # tantivy インデックス
│   │       └── tokenizer.rs       # lindera 日本語トークナイザ
│   └── ccsquad-cli/               # 統合 CLI バイナリ
│       └── src/
│           ├── main.rs            # エントリポイント + clap 定義
│           ├── cmd_job.rs         # ccsquad job サブコマンド
│           └── cmd_memory.rs      # ccsquad memory サブコマンド
```

## Phase 1: Workspace + ccsquad-core

### 1-1. Workspace Cargo.toml

```toml
[workspace]
members = ["crates/*"]
resolver = "2"

[workspace.package]
edition = "2024"
version = "0.1.0"
license = "MIT"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_yaml = "0.9"
thiserror = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
clap = { version = "4", features = ["derive"] }
indexmap = { version = "2", features = ["serde"] }
chrono = { version = "0.4", features = ["serde"] }
```

### 1-2. ccsquad-core/src/error.rs
- `Error` enum: `Io`, `Serialization`, `Config(String)`, `Job(String)`, `Workflow(String)`, `Memory(String)`, `Index(String)`
- `pub type Result<T> = std::result::Result<T, Error>`

### 1-3. ccsquad-core/src/frontmatter.rs
- `pub fn parse(content: &str) -> Result<(String, String)>` — YAML 部分と body を分離
- `pub fn write(yaml: &str, body: &str) -> String` — frontmatter + body を結合
- テスト: 正常系、body なし、frontmatter なし

### 検証
- `cargo build --workspace`
- `cargo test -p ccsquad-core`

---

## Phase 2: ccsquad-jobs (ライブラリ)

### 2-1. job.rs
- 構造体: `Job`, `JobStatus`(Pending/Running/Completed/Failed/Aborted)
- `JobStore`: ファイルベース永続化（`.ccsquad/jobs/`）
  - ID 形式: `J000001`, `J000002`, ...
  - フォーマット: YAML frontmatter + Markdown body
  - frontmatter フィールド: `id`, `title`, `workflow`(必須), `status`, `current_phase`, `priority`, `depends_on`, `created_at`, `updated_at`
  - CRUD: `save`, `load`, `list_all`, `delete`, `next_id`
  - ジョブファイル例:
    ```markdown
    ---
    id: J000003
    title: 認証機能 - 統合テスト
    workflow: dev
    status: running
    current_phase: code
    priority: 5
    depends_on: [J000001, J000002]
    created_at: 2026-03-24T09:00:00Z
    updated_at: 2026-03-24T11:00:00Z
    ---
    ## 説明
    JWT ベースの認証機能を実装する。

    ## フェーズログ
    ### plan (completed → code) - 2026-03-24T10:00:00Z
    計画を策定した。

    ### code (completed → review) - 2026-03-24T10:30:00Z
    実装完了。

    ### review (rejected → code) - 2026-03-24T11:00:00Z
    テストが不足している。エッジケースのカバレッジを追加すること。
    ```
  - `transition` 時に body の「## フェーズログ」セクションにエントリを追記
  - フォーマット: `### {phase} ({result} → {next}) - {timestamp}\n{message}`
- テスト: CRUD 操作、ID 採番、ステータス遷移

### 2-2. config.rs
- `SquadConfig { workflows: IndexMap<String, WorkflowConfig> }` — ccsquad.yaml のトップレベル
- `WorkflowConfig` — ステートマシン定義
  - `description: Option<String>` — ワークフローの説明
  - `phases: IndexMap<String, PhaseConfig>` — フェーズ定義（最初のキーが開始フェーズ）
- `PhaseConfig` — 各フェーズの設定
  - `description: Option<String>` — フェーズの説明
  - `agent: Option<String>` — 実行エージェント
  - `reviewer: Option<String>` — レビュアー（指定時はレビュー承認が必要）
  - `on: IndexMap<TransitionCondition, String>` — 遷移ルール（条件 → 遷移先）
- `TransitionCondition` — 条件（`completed` / `failed` / `rejected` / `approved`）
- 遷移先の値: フェーズ名 または 特殊値 `COMPLETE` / `ABORT`
- すべての遷移先を `on` で明示的に指定する（デフォルト規約なし）
  - 通常フェーズ: `on.completed` 必須
  - reviewer フェーズ: `on.approved` と `on.rejected` 必須
- `initial_phase()` — phases の最初のキーを返す
- `resolve_transition(phase, condition)` — `on` から遷移先を取得。未定義ならエラー
- `validate()` — 遷移先フェーズの存在チェック、到達不能フェーズの警告、通常フェーズに `on.completed` があることの検証、reviewer 付きフェーズに `on.approved` と `on.rejected` があることの検証
- ccsquad.yaml の例:
  ```yaml
  workflows:
    dev:
      description: 開発ワークフロー
      phases:
        plan:
          description: 実装計画を策定する
          agent: planner
          on:
            completed: code
            failed: ABORT
        code:
          description: コードを実装する
          agent: coder
          on:
            completed: review
            failed: plan
        review:
          description: コードレビューを行う
          agent: reviewer
          reviewer: human
          on:
            approved: COMPLETE
            rejected: code
    bugfix:
      description: バグ修正ワークフロー
      phases:
        investigate:
          description: 原因を調査する
          agent: coder
          on:
            completed: fix
            failed: ABORT
        fix:
          description: 修正を実施する
          agent: coder
          on:
            completed: verify
            failed: investigate
        verify:
          description: 修正を検証する
          agent: reviewer
          on:
            completed: COMPLETE
            failed: fix
  ```
### 2-3. engine.rs
- `WorkflowEngine` — ステートマシン型フェーズ遷移エンジン
- メソッド:
  - `start_job(job_id)` — `depends_on` の全ジョブが `completed` であることを検証（未完了ならエラー）。ジョブが `pending` であることを検証（`completed`/`failed`/`aborted` ならエラー）。`initial_phase()`（最初のフェーズ）にセットして `running` に遷移
  - `transition(job_id, result, message)` — reviewer 付きフェーズではエラー（`approve`/`reject` を使用）。`resolve_transition()` で遷移先を決定（`on` → デフォルト規約の順）。次フェーズへ遷移。`COMPLETE` / `ABORT` なら終了。body のフェーズログセクションにエントリ追記
  - `approve(job_id, message)` — reviewer 付きフェーズでのみ有効（それ以外はエラー）。`approved` として遷移ルール評価
  - `reject(job_id, message)` — reviewer 付きフェーズでのみ有効（それ以外はエラー）。`rejected` として遷移ルール評価。reject 理由をフェーズログに記録
  - `abort_job(job_id)` — 手動中断
  - `get_status(job_id)` — 現在のフェーズ・ステータスを取得
- テスト:
  - 直線ワークフロー（plan → code → review → COMPLETE）
  - ループワークフロー（review → rejected → code → review）
  - 失敗時のフォールバック（code → failed → plan）
  - reviewer 付きフェーズの approve / reject
  - depends_on による依存チェック
  - depends_on の循環依存検出
  - 完了/失敗/中断済みジョブの再実行拒否
  - reviewer 付きフェーズでの transition 拒否
  - reviewer なしフェーズでの approve/reject 拒否
  - ルール不一致時のエラー

### 検証
- `cargo build -p ccsquad-jobs`
- `cargo test -p ccsquad-jobs`

---

## Phase 3: ccsquad-memory (ライブラリ)

### 3-1. entry.rs
- `MemoryEntry` 構造体: `id`, `title`, `tags: Vec<String>`, `body`, `created_at`, `updated_at`
- `EntryStore`: JobStore と同じパターン
  - 保存先: `.ccsquad/memory/entries/`
  - ID 形式: `M000001`, `M000002`, ...
  - CRUD: `save`, `load`, `list_all`, `delete`, `next_id`
- frontmatter 形式:
  ```yaml
  ---
  id: M000001
  title: 認証方式
  tags: [auth, security]
  created_at: 2026-03-23T12:00:00Z
  updated_at: 2026-03-23T12:00:00Z
  ---
  JWTを採用。セッショントークンは...
  ```

### 3-2. tokenizer.rs
- lindera の外部辞書ロード
- `pub fn load_japanese_tokenizer(dict_path: &Path) -> Result<impl tantivy::tokenizer::Tokenizer>`
- 辞書がなければデフォルトトークナイザにフォールバック（警告表示）
- `pub fn download_dictionary(target_dir: &Path) -> Result<()>` — 辞書のダウンロード

### 3-3. index.rs
- `MemoryIndex` 構造体（tantivy ラッパー）
- スキーマ: `id` (STORED), `title` (TEXT+STORED), `body` (TEXT+STORED), `tags` (STRING+STORED)
- メソッド:
  - `open_or_create(index_dir, tokenizer)` — インデックス作成/オープン
  - `add_entry(entry)` — エントリをインデックスに追加
  - `remove_entry(id)` — インデックスから削除
  - `search(query, limit) -> Vec<SearchResult>` — 全文検索
  - `search_by_tags(tags, limit)` — タグフィルタ検索
  - `rebuild(store)` — 全エントリ再インデックス
- `SearchResult`: `id`, `title`, `snippet`, `score`, `tags`

### 検証
- `cargo build -p ccsquad-memory`
- `cargo test -p ccsquad-memory`

---

## Phase 4: ccsquad-cli (統合バイナリ)

### 4-1. main.rs
- clap でトップレベルサブコマンドを定義: `job`, `memory`
- `find_config()` で `ccsquad.yaml` を探索（カレントディレクトリから親を辿る）
- `.ccsquad/` ディレクトリの自動作成
- `tracing_subscriber` 初期化
- バイナリ名: `ccsquad`

### 4-2. cmd_job.rs
- `ccsquad job` サブコマンド群（出力メッセージ日本語）
- `JobAction` enum: List, Show, Add, Edit, Run, Transition, Approve, Reject, Abort
- `job add` で `--workflow` を必須引数とし、`ccsquad.yaml` に定義されたワークフロー名を検証
- `job add` で `--depends-on` 指定時に循環依存を検出してエラー
- `job edit` で変更可能なフィールド: `--title`, `--description`, `--priority`, `--depends-on`（`status`, `current_phase` 等のエンジン管理フィールドは変更不可）
- `job show` でジョブの全情報（frontmatter + body + 現フェーズの設定）を表示。`--format json` でマシンリーダブル出力
- ハンドラ: `cmd_list`, `cmd_show`, `cmd_add`, `cmd_edit`, `cmd_run`, `cmd_transition`, `cmd_approve`, `cmd_reject`, `cmd_abort`

### 4-3. cmd_memory.rs
- `ccsquad memory` サブコマンド群（出力メッセージ日本語）
- `MemoryAction` enum: Init, Add, List, Show, Edit, Delete, Search, Rebuild
- ハンドラ: `cmd_init`, `cmd_add`, `cmd_list`, `cmd_show`, `cmd_edit`, `cmd_delete`, `cmd_search`, `cmd_rebuild`

### 検証
- `cargo build -p ccsquad-cli`
- 手動テスト:
  ```bash
  ccsquad job add "テストジョブ" --workflow dev --description "説明" --priority 5 --depends-on J000001,J000002
  ccsquad job list
  ccsquad job show J000001
  ccsquad job run J000001
  ccsquad job transition J000001 completed --message "実装完了"
  ccsquad job reject J000001 --message "テストが不足"
  ccsquad job approve J000001
  ccsquad job show J000001 --format json

  ccsquad memory init --lang ja
  ccsquad memory add "認証方式" --tags auth,security "JWTを採用..."
  ccsquad memory search "認証"
  ccsquad memory list --tag auth
  ccsquad memory show M000001
  ccsquad memory delete M000001
  ```

---

## Phase 5: Skill + エージェント定義（コード実装後）

Phase 1-4 の CLI 実装が完了した後に着手。

- `skills/dev.md` — ワークフロー実行 skill（ccsquad CLI を呼び出す）
- `agents/planner.md`, `agents/coder.md`, `agents/reviewer.md` — サブエージェント定義

---

## 設計参考元

コード流用はしない。以下を設計の参考とする:
- ccguild — Job 構造体、CLI コマンド構成
- [takt](https://github.com/nrslib/takt) — ステートマシン型ワークフロー、遷移ルール設計、ループ検出

## 依存 crate

| crate | 用途 | 対象 |
|---|---|---|
| `serde` + `serde_yaml` | YAML シリアライズ | 全体 |
| `thiserror` | エラー型 | core |
| `clap` | CLI パーサ | cli |
| `indexmap` | 順序付き HashMap | jobs (phases) |
| `tracing` | ログ | 全体 |
| `chrono` | タイムスタンプ | memory |
| `tantivy` | 全文検索 | memory |
| `lindera-tantivy` | 日本語トークナイザ | memory |
