import { describe, it, expect } from "bun:test";
import { parseReviewerChecklist, updateAcceptanceCriteria } from "../../src/domain/acceptance-criteria.js";
import type { AcceptanceCriterion } from "../../src/domain/types.js";

describe("parseReviewerChecklist", () => {
  it("[x] チェック済み行を検出する", () => {
    const items = parseReviewerChecklist("- [x] 機能Aが動作する");
    expect(items).toEqual([{ description: "機能Aが動作する", checked: true }]);
  });

  it("[X] 大文字でもチェック済みと判定する", () => {
    const items = parseReviewerChecklist("- [X] 機能Aが動作する");
    expect(items[0].checked).toBe(true);
  });

  it("[ ] 未チェック行を検出する", () => {
    const items = parseReviewerChecklist("- [ ] 機能Bが動作する");
    expect(items).toEqual([{ description: "機能Bが動作する", checked: false }]);
  });

  it("* マーカーでも検出する", () => {
    const items = parseReviewerChecklist("* [x] 機能A");
    expect(items).toHaveLength(1);
    expect(items[0].checked).toBe(true);
  });

  it("コロン以降の補足テキストを除いた description を返す", () => {
    const items = parseReviewerChecklist("- [x] 機能A: 補足説明はここに書く");
    expect(items[0].description).toBe("機能A");
  });

  it("複数行をすべてパースする", () => {
    const message = `- [x] 基準1\n- [ ] 基準2\n- [x] 基準3`;
    const items = parseReviewerChecklist(message);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ description: "基準1", checked: true });
    expect(items[1]).toEqual({ description: "基準2", checked: false });
    expect(items[2]).toEqual({ description: "基準3", checked: true });
  });

  it("チェックリスト行がない場合は空配列", () => {
    expect(parseReviewerChecklist("チェックリストなし")).toEqual([]);
  });

  it("インデントされた行も検出する", () => {
    const items = parseReviewerChecklist("  - [x] インデント付き基準");
    expect(items).toHaveLength(1);
    expect(items[0].checked).toBe(true);
  });
});

describe("updateAcceptanceCriteria", () => {
  const makeCriteria = (items: Array<{ description: string; done?: boolean }>): AcceptanceCriterion[] =>
    items.map(({ description, done = false }) => ({ description, done }));

  it("チェック済み項目に一致する AC を done にする", () => {
    const criteria = makeCriteria([{ description: "機能Aが動作する" }]);
    const result = updateAcceptanceCriteria(criteria, "- [x] 機能Aが動作する");
    expect(result[0].done).toBe(true);
  });

  it("未チェック項目は done を変更しない", () => {
    const criteria = makeCriteria([{ description: "機能Aが動作する" }]);
    const result = updateAcceptanceCriteria(criteria, "- [ ] 機能Aが動作する");
    expect(result[0].done).toBe(false);
  });

  it("既に done な AC は false に戻らない", () => {
    const criteria = makeCriteria([{ description: "機能Aが動作する", done: true }]);
    const result = updateAcceptanceCriteria(criteria, "- [ ] 機能Aが動作する");
    expect(result[0].done).toBe(true);
  });

  it("チェックリストがない場合は criteria をそのまま返す", () => {
    const criteria = makeCriteria([{ description: "機能A" }]);
    const result = updateAcceptanceCriteria(criteria, "チェックリストなし");
    expect(result).toEqual(criteria);
  });

  it("大文字小文字を無視して fuzzy match する", () => {
    const criteria = makeCriteria([{ description: "Feature A is working" }]);
    const result = updateAcceptanceCriteria(criteria, "- [x] feature a is working");
    expect(result[0].done).toBe(true);
  });

  it("AC の description がチェックリスト description を含む場合にマッチする", () => {
    const criteria = makeCriteria([{ description: "ファイルが正しく保存される" }]);
    const result = updateAcceptanceCriteria(criteria, "- [x] ファイルが正しく保存される: 確認済み");
    expect(result[0].done).toBe(true);
  });

  it("複数 AC の一部だけを更新する", () => {
    const criteria = makeCriteria([{ description: "機能A" }, { description: "機能B" }]);
    const result = updateAcceptanceCriteria(criteria, "- [x] 機能A");
    expect(result[0].done).toBe(true);
    expect(result[1].done).toBe(false);
  });
});
