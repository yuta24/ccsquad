# ccsquad

ステートマシン型ワークフローエンジンを備えたジョブ管理 CLI ツール。

## インストール

### CLI

#### Cargo からビルド

```bash
cargo install --path crates/ccsquad-cli
```

#### ソースからビルド

```bash
git clone https://github.com/yuta24/ccsquad.git
cd ccsquad
cargo build --release
```

ビルド後、`target/release/ccsquad` にバイナリが生成されます。必要に応じて PATH の通ったディレクトリにコピーしてください。

```bash
cp target/release/ccsquad /usr/local/bin/
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

インストール後、プロジェクトルートに `ccsquad.yaml` を配置してワークフローを定義してください。

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