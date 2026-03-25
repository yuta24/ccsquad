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

`ccsquad setup` コマンドで、プロジェクトに必要なファイルを一括生成できます。

```bash
cd /path/to/your-project
ccsquad setup
```

以下のファイルが自動的に作成されます:

- `ccsquad.yaml` — ワークフロー定義
- `.claude/skills/` — スキル定義 (job, job-run, job-approve, job-reject, memory)
- `.claude/agents/` — エージェント定義 (coder, reviewer)

既存ファイルはスキップされます。`--force` で上書きできます。

```bash
# 既存ファイルを上書き
ccsquad setup --force

# 特定のステップをスキップ
ccsquad setup --skip-agents
```

#### 手動セットアップ

`ccsquad setup` を使わずに手動で設定する場合は、プロジェクトルートに `ccsquad.yaml` を配置してワークフローを定義してください。

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
```