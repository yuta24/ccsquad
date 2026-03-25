import { describe, it, expect } from "bun:test";
import { truncate, padRight, adjustViewportOffset } from "../src/util.js";

describe("truncate", () => {
  it("maxLen 以下の文字列はそのまま返す", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("maxLen ちょうどの文字列はそのまま返す", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("maxLen を超える文字列は切り詰めて .. を付ける", () => {
    expect(truncate("hello world", 7)).toBe("hello..");
  });

  it("日本語文字列を正しく切り詰める", () => {
    expect(truncate("あいうえおかきく", 5)).toBe("あいう..");
  });

  it("空文字列はそのまま返す", () => {
    expect(truncate("", 5)).toBe("");
  });
});

describe("padRight", () => {
  it("指定幅まで半角スペースでパディングする", () => {
    expect(padRight("abc", 6)).toBe("abc   ");
  });

  it("文字列が指定幅ちょうどならそのまま返す", () => {
    expect(padRight("abcde", 5)).toBe("abcde");
  });

  it("文字列が指定幅を超える場合は切り詰める", () => {
    expect(padRight("abcdefgh", 5)).toBe("abcde");
  });

  it("日本語文字列をパディングする", () => {
    const result = padRight("あい", 5);
    expect(result).toBe("あい   ");
  });

  it("空文字列をパディングする", () => {
    expect(padRight("", 3)).toBe("   ");
  });
});

describe("adjustViewportOffset", () => {
  it("カーソルがビューポート内なら offset を変更しない", () => {
    expect(adjustViewportOffset(3, 0, 10)).toBe(0);
    expect(adjustViewportOffset(5, 2, 10)).toBe(2);
    expect(adjustViewportOffset(9, 0, 10)).toBe(0);
  });

  it("カーソルがビューポートの上に出たら offset をカーソル位置に", () => {
    expect(adjustViewportOffset(2, 5, 10)).toBe(2);
    expect(adjustViewportOffset(0, 3, 10)).toBe(0);
  });

  it("カーソルがビューポートの下に出たら offset を調整", () => {
    expect(adjustViewportOffset(10, 0, 10)).toBe(1);
    expect(adjustViewportOffset(15, 0, 10)).toBe(6);
    expect(adjustViewportOffset(20, 5, 10)).toBe(11);
  });

  it("カーソルがビューポートの最終位置にある場合は変更しない", () => {
    // cursor=9, offset=0, height=10 → 9 < 0+10 なので変更なし
    expect(adjustViewportOffset(9, 0, 10)).toBe(0);
  });

  it("ビューポート高さ 1 の場合は常にカーソル追従", () => {
    expect(adjustViewportOffset(0, 0, 1)).toBe(0);
    expect(adjustViewportOffset(5, 0, 1)).toBe(5);
    expect(adjustViewportOffset(3, 5, 1)).toBe(3);
  });

  it("カーソル 0 の場合は offset 0", () => {
    expect(adjustViewportOffset(0, 10, 5)).toBe(0);
    expect(adjustViewportOffset(0, 0, 5)).toBe(0);
  });
});
