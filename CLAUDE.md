# ccsquad

ステートマシン型ワークフローエンジン CLI。Claude Code の「計画→実装→評価」ループを強制するハーネス。

ワークフローはジョブ作成時にインラインで定義し、ジョブ body に `## Workflow` セクションとして埋め込まれる。

## 設計ドキュメント

- [docs/design-principles.md](docs/design-principles.md) — 状態遷移の設計原則（実装・レビュー時に参照）
