# ccsquad

ステートマシン型ワークフローエンジンを備えたジョブ管理 CLI ツール。

## インストール

### CLI

```bash
git clone https://github.com/yuta24/ccsquad.git
cd ccsquad
bun install
bun run build
```

ビルド後、`dist/ccsquad` バイナリが生成されます。必要に応じて PATH の通ったディレクトリにコピーしてください。

```bash
cp dist/ccsquad /usr/local/bin/
```

### Agent Skill (Claude Code プラグイン)

Claude Code から ccsquad のジョブ管理機能を利用するためのスキルです。

#### プロジェクト単位でインストール

```bash
claude skill add --file skills/job/SKILL.md
```

#### 別リポジトリからインストール

```bash
claude skill add --url https://github.com/yuta24/ccsquad/blob/main/skills/job/SKILL.md
```

### セットアップ

ワークフローは `ccsquad job add` コマンドでインラインに定義します。

```bash
ccsquad job add "機能追加" \
  --phases "plan:plan:planner,code:execute:developer,review:review" \
  --transitions "plan:completed>code,plan:failed>ABORT,code:completed>review,code:failed>plan,review:approved>COMPLETE,review:rejected>code"
```

利用可能なスキル:

- `job` — ジョブ管理 (作成・一覧・遷移・中断など)
- `run-job` — ジョブの自動実行オーケストレーション
- `dag` — DAG ベースのマルチジョブ並列実行
- `harness` — ハーネス設計の原則

利用可能なエージェント:

- `developer` — 実装エージェント (plan/execute フェーズのデフォルト)
- `planner` — 計画策定エージェント
- `reviewer` — レビューエージェント (review フェーズのデフォルト)