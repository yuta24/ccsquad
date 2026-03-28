import { describe, it, expect } from "bun:test";
import { truncate, padRight } from "../src/util.js";

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
