# ccsquad

ステートマシン型ワークフローエンジン CLI。Claude Code の「計画→実装→レビュー」ループを強制するハーネス。

## インストール

```bash
curl -fsSL https://raw.githubusercontent.com/yuta24/ccsquad/main/install.sh | bash
```

デフォルトのインストール先は `/usr/local/bin` です。書き込み権限がない場合は `sudo` が実行されパスワードを求められます。パスワードを入力したくない場合は `INSTALL_DIR` で書き込み権限のあるディレクトリを指定してください:

```bash
curl -fsSL https://raw.githubusercontent.com/yuta24/ccsquad/main/install.sh | INSTALL_DIR=~/.local/bin bash
```

`~/.local/bin` を使う場合は `PATH` に含まれているか確認してください:

```bash
echo $PATH | grep -q "$HOME/.local/bin" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

対応環境: macOS (arm64 / x64)、Linux (arm64 / x64)

## 基本的な使い方

インストール後の保存先とエージェント連携の確認:

```bash
ccsquad doctor
```

```bash
# 1. ジョブを作成する（stdout に ID が出力される）
ID=$(ccsquad create "認証機能の追加" 2>/dev/null)

# 2. ジョブを開始する
ccsquad run $ID

# 3. プロンプトを取得してエージェントに渡す
claude -p "$(ccsquad prompt $ID)"

# 4. フェーズを遷移する（--message がフェーズログに自動記録される）
ccsquad done $ID completed --message "実装完了。テスト全件パス"

# 5. レビューフェーズでは人間が承認/却下する
ccsquad done $ID approved  --message "LGTM"
ccsquad done $ID rejected  --message "テストカバレッジが不足"
```

### prompt の exit code

```bash
ccsquad prompt $ID
# exit 0 → プロンプト出力（実行継続）
# exit 2 → 人間レビュー待ち（review フェーズ）
# exit 3 → ジョブ終了（completed / failed / aborted）
```

エージェント自動実行ループの例：

```bash
ID=$(ccsquad create "タスク名" --workflow develop 2>/dev/null)
ccsquad run $ID
while ccsquad prompt $ID | claude --print -; do
  ccsquad done $ID completed --message "完了"
done
# exit 2 → 人間レビュー / exit 3 → 完了
```

Codex に渡す場合:

```bash
codex exec "$(ccsquad prompt $ID)"
```

## ワークフロープリセット

`--workflow` を省略すると `basic` が使われます。

| プリセット | フロー |
|-----------|--------|
| `basic`   | plan → execute → review(human) → COMPLETE |
| `develop` | plan → execute → review(auto) → COMPLETE |
| `simple`  | execute → review(human) → COMPLETE |
| `gated`   | plan → review(human) → execute → review(auto) → COMPLETE |

```bash
ccsquad create "タスク名"                    # basic（デフォルト）
ccsquad create "タスク名" --workflow develop  # 自動レビュー
ccsquad create "タスク名" --workflow simple   # plan なし
ccsquad create "タスク名" --workflow gated    # 計画を人間が承認後、以降は自動
```

カスタムワークフローはファイルで渡せます：

```bash
ccsquad create "タスク名" --workflow my-workflow.yaml
```

ワークフロー設計の考え方は [docs/harness-design-guide.md](docs/harness-design-guide.md) を参照してください。

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `create <title>` | ジョブを作成する（stdout: ID のみ） |
| `run <id>` | ジョブを開始する（pending → running） |
| `prompt <id>` | 現在フェーズのプロンプトを stdout に出力する |
| `done <id> <result>` | フェーズを遷移する（`--message` でログ自動記録） |
| `show <id>` | ジョブ詳細を表示する |
| `list` | ジョブ一覧を表示する |
| `doctor` | 保存先とエージェント連携の最小設定を確認する |
| `update <id>` | タイトル・説明・AC を更新する |
| `abort <id>` | ジョブを中断する |

## Claude Code の設定

### 推奨 settings.json

ccsquad コマンドを Claude Code エージェントから自動実行できるようにする設定です。
プロジェクトルートの `.claude/settings.json` に追記してください。

```json
{
  "permissions": {
    "allow": [
      "Bash(ccsquad *)"
    ]
  }
}
```

### 人間レビューコマンドを保護する

`approved` / `rejected` は人間だけが実行できるよう制限する場合：

```json
{
  "permissions": {
    "allow": [
      "Bash(ccsquad *)"
    ],
    "deny": [
      "Bash(ccsquad done * approved*)",
      "Bash(ccsquad done * rejected*)"
    ]
  }
}
```

`deny` は `allow` より優先されます。これにより、フェーズ遷移（`completed`/`failed`）はエージェントが自動実行し、レビュー判定（`approved`/`rejected`）は毎回確認プロンプトが表示されます。

### ユーザー全体に適用する場合

`~/.claude/settings.json` に同様の設定を追記してください。
