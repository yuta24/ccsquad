import { describe, it, expect } from "bun:test";
import { formatLintResult } from "../src/commands/lint.js";
import type { Diagnostic } from "../src/config.js";

function makeConfig(phases: { name: string; type: string }[]): {
  workflows: Record<string, { phases: { name: string; type: string }[] }>;
} {
  return {
    workflows: {
      dev: { phases },
    },
  };
}

describe("formatLintResult", () => {
  it("有効な設定は全チェックマーク、0 errors 0 warnings", () => {
    const config = makeConfig([
      { name: "plan", type: "task" },
      { name: "code", type: "task" },
      { name: "review", type: "review" },
    ]);
    const diagnostics: Diagnostic[] = [];
    const { output, errorCount, warningCount } = formatLintResult(config, diagnostics);

    expect(errorCount).toBe(0);
    expect(warningCount).toBe(0);
    expect(output).toContain("✓ plan (task)");
    expect(output).toContain("✓ code (task)");
    expect(output).toContain("✓ review (review)");
    expect(output).toContain("問題は見つかりませんでした");
  });

  it("エラーがある場合はクロスマークとエラーメッセージを表示", () => {
    const config = makeConfig([
      { name: "plan", type: "task" },
      { name: "code", type: "task" },
    ]);
    const diagnostics: Diagnostic[] = [
      { severity: "error", workflow: "dev", phase: "code", message: "agent が設定されていません" },
    ];
    const { output, errorCount, warningCount } = formatLintResult(config, diagnostics);

    expect(errorCount).toBe(1);
    expect(warningCount).toBe(0);
    expect(output).toContain("✓ plan (task)");
    expect(output).toContain("✗ code (task)");
    expect(output).toContain("error: agent が設定されていません");
    expect(output).toContain("結果: 1 errors, 0 warnings");
  });

  it("警告がある場合は警告メッセージを表示", () => {
    const config = makeConfig([
      { name: "plan", type: "task" },
      { name: "orphan", type: "task" },
    ]);
    const diagnostics: Diagnostic[] = [
      { severity: "warning", workflow: "dev", phase: "orphan", message: "到達不能なフェーズです" },
    ];
    const { output, errorCount, warningCount } = formatLintResult(config, diagnostics);

    expect(errorCount).toBe(0);
    expect(warningCount).toBe(1);
    expect(output).toContain("✗ orphan (task)");
    expect(output).toContain("warning: 到達不能なフェーズです");
    expect(output).toContain("結果: 0 errors, 1 warnings");
  });

  it("複数エラーを一度に収集する", () => {
    const config = makeConfig([
      { name: "plan", type: "task" },
      { name: "code", type: "task" },
    ]);
    const diagnostics: Diagnostic[] = [
      { severity: "error", workflow: "dev", phase: "plan", message: "agent が設定されていません" },
      { severity: "error", workflow: "dev", phase: "code", message: "'completed' ルールがありません" },
    ];
    const { output, errorCount } = formatLintResult(config, diagnostics);

    expect(errorCount).toBe(2);
    expect(output).toContain("✗ plan (task)");
    expect(output).toContain("✗ code (task)");
    expect(output).toContain("結果: 2 errors, 0 warnings");
  });

  it("フェーズなしエラー（ワークフローレベル）を表示", () => {
    const config = makeConfig([]);
    const diagnostics: Diagnostic[] = [
      { severity: "error", workflow: "dev", message: "フェーズが定義されていません" },
    ];
    const { output, errorCount } = formatLintResult(config, diagnostics);

    expect(errorCount).toBe(1);
    expect(output).toContain("ワークフロー: dev");
    expect(output).toContain("✗ (ワークフロー)");
    expect(output).toContain("error: フェーズが定義されていません");
  });
});
