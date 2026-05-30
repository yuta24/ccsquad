# ccsquad

ステートマシン型ワークフローエンジン CLI。Claude Code の「計画→実装→評価」ループを強制するハーネス。

ワークフローはジョブ作成時に定義し、ジョブファイルの frontmatter に YAML として保存される。`--workflow` にはプリセット名、JSON/YAML 文字列、ファイルパス、または `-` による stdin を指定できる。

## 設計ドキュメント

- [docs/design-principles.md](docs/design-principles.md) — 状態遷移の設計原則（実装・レビュー時に参照）
- [docs/harness-design-guide.md](docs/harness-design-guide.md) — ハーネス設計の原則とワークフロー構成の判断基準
