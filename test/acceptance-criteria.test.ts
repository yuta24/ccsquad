import { describe, it, expect } from "bun:test";
import { parseReviewerChecklist, updateAcceptanceCriteria } from "../src/domain/acceptance-criteria.js";
import type { AcceptanceCriterion } from "../src/domain/types.js";

// ─── parseReviewerChecklist ────────────────────────────────────────────────

describe("parseReviewerChecklist", () => {
  it("パースされたチェックリストを返す", () => {
    const message = `## 検証結果
- [x] 認証機能: JWT トークンの発行を確認
- [ ] エラーハンドリング: 未実装
- [x] テスト: 全テスト通過`;

    const items = parseReviewerChecklist(message);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ description: "認証機能", checked: true });
    expect(items[1]).toEqual({ description: "エラーハンドリング", checked: false });
    expect(items[2]).toEqual({ description: "テスト", checked: true });
  });

  it("コロンなしの行はそのまま description になる", () => {
    const message = "- [x] 認証機能が正しく動作する";
    const items = parseReviewerChecklist(message);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ description: "認証機能が正しく動作する", checked: true });
  });

  it("チェックリストがない場合は空配列を返す", () => {
    const message = "LGTM! 問題ありません。";
    const items = parseReviewerChecklist(message);
    expect(items).toEqual([]);
  });

  it("空文字列では空配列を返す", () => {
    expect(parseReviewerChecklist("")).toEqual([]);
  });

  it("大文字 X もチェック済みとして扱う", () => {
    const message = "- [X] 基準1: OK";
    const items = parseReviewerChecklist(message);
    expect(items[0].checked).toBe(true);
  });

  it("アスタリスクのリストマーカーも対応する", () => {
    const message = "* [x] 基準1: OK";
    const items = parseReviewerChecklist(message);
    expect(items).toHaveLength(1);
    expect(items[0].checked).toBe(true);
  });
});

// ─── updateAcceptanceCriteria ──────────────────────────────────────────────

describe("updateAcceptanceCriteria", () => {
  const baseCriteria: AcceptanceCriterion[] = [
    { description: "認証機能が動作する", done: false },
    { description: "エラーハンドリング", done: false },
    { description: "テストが通る", done: false },
  ];

  it("チェック済み項目の done を true に更新する", () => {
    const message = `## 検証結果
- [x] 認証機能が動作する: 確認済み
- [ ] エラーハンドリング: 未実装
- [x] テストが通る: 全パス`;

    const updated = updateAcceptanceCriteria(baseCriteria, message);
    expect(updated[0].done).toBe(true);
    expect(updated[1].done).toBe(false);
    expect(updated[2].done).toBe(true);
  });

  it("既に done: true の項目は false に戻らない", () => {
    const criteria: AcceptanceCriterion[] = [
      { description: "認証機能が動作する", done: true },
      { description: "エラーハンドリング", done: false },
    ];
    const message = `- [ ] 認証機能が動作する: 回帰テスト中
- [ ] エラーハンドリング: 未実装`;

    const updated = updateAcceptanceCriteria(criteria, message);
    expect(updated[0].done).toBe(true); // reverted しない
    expect(updated[1].done).toBe(false);
  });

  it("チェックリストがない場合は元の配列をそのまま返す", () => {
    const updated = updateAcceptanceCriteria(baseCriteria, "LGTM!");
    expect(updated).toEqual(baseCriteria);
  });

  it("部分一致でマッチする", () => {
    const criteria: AcceptanceCriterion[] = [
      { description: "認証機能", done: false },
    ];
    const message = "- [x] 認証機能が正しく動作する: OK";
    const updated = updateAcceptanceCriteria(criteria, message);
    expect(updated[0].done).toBe(true);
  });

  it("大文字小文字を区別しないでマッチする", () => {
    const criteria: AcceptanceCriterion[] = [
      { description: "API endpoint works", done: false },
    ];
    const message = "- [x] api endpoint works: verified";
    const updated = updateAcceptanceCriteria(criteria, message);
    expect(updated[0].done).toBe(true);
  });

  it("マッチしない項目は変更しない", () => {
    const criteria: AcceptanceCriterion[] = [
      { description: "全く関係ない基準", done: false },
    ];
    const message = "- [x] 認証機能: OK";
    const updated = updateAcceptanceCriteria(criteria, message);
    expect(updated[0].done).toBe(false);
  });

  it("空の AC 配列では空配列を返す", () => {
    const updated = updateAcceptanceCriteria([], "- [x] 何か: OK");
    expect(updated).toEqual([]);
  });
});
