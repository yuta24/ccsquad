import { describe, it, expect } from "bun:test";
import { truncate, padRight, displayWidth } from "../src/util.js";

describe("displayWidth", () => {
  it("ASCII 文字列は文字数と同じ", () => {
    expect(displayWidth("hello")).toBe(5);
  });

  it("CJK 文字は幅 2", () => {
    expect(displayWidth("あいう")).toBe(6);
  });

  it("混在文字列の幅を正しく計算する", () => {
    expect(displayWidth("aあb")).toBe(4);
  });

  it("空文字列は 0", () => {
    expect(displayWidth("")).toBe(0);
  });
});

describe("truncate", () => {
  it("maxWidth 以下の文字列はそのまま返す", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("maxWidth ちょうどの文字列はそのまま返す", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("maxWidth を超える文字列は切り詰めて .. を付ける", () => {
    expect(truncate("hello world", 7)).toBe("hello..");
  });

  it("日本語文字列を表示幅で正しく切り詰める", () => {
    // "あいうえおかきく" = 幅16, maxWidth=8 → "あいう.." (幅6+2=8)
    expect(truncate("あいうえおかきく", 8)).toBe("あいう..");
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

  it("文字列が指定幅以上の場合はそのまま返す", () => {
    expect(padRight("abcdefgh", 5)).toBe("abcdefgh");
  });

  it("日本語文字列を表示幅でパディングする", () => {
    // "あい" = 幅4, padRight(_, 6) → "あい  " (スペース2個)
    const result = padRight("あい", 6);
    expect(result).toBe("あい  ");
  });

  it("空文字列をパディングする", () => {
    expect(padRight("", 3)).toBe("   ");
  });
});
