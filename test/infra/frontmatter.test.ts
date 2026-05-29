import { describe, it, expect } from "bun:test";
import { parse, write } from "../../src/infra/frontmatter.js";

describe("parse", () => {
  it("標準的な frontmatter をパースできる", () => {
    const content = `---\nid: J000001\ntitle: テスト\n---\nbody content\n`;
    const { yaml, body } = parse(content);
    expect(yaml).toBe("id: J000001\ntitle: テスト");
    expect(body).toBe("body content\n");
  });

  it("body が空のファイルをパースできる", () => {
    const content = `---\nid: J000001\n---\n`;
    const { yaml, body } = parse(content);
    expect(yaml).toBe("id: J000001");
    expect(body).toBe("");
  });

  it("先頭の空行を無視する", () => {
    const content = `\n\n---\nid: J000001\n---\nbody\n`;
    const { yaml, body } = parse(content);
    expect(yaml).toBe("id: J000001");
    expect(body).toBe("body\n");
  });

  it("frontmatter がない場合はエラー", () => {
    expect(() => parse("no frontmatter")).toThrow("frontmatter が見つかりません");
  });

  it("終端 --- がない場合はエラー", () => {
    expect(() => parse("---\nid: J000001\n")).toThrow("frontmatter の終端が見つかりません");
  });
});

describe("write", () => {
  it("yaml と body を結合して出力する", () => {
    const result = write("id: J000001", "body content\n");
    expect(result).toBe("---\nid: J000001\n---\nbody content\n");
  });

  it("body が空の場合は body 部分なし", () => {
    const result = write("id: J000001", "");
    expect(result).toBe("---\nid: J000001\n---\n");
  });

  it("yaml 末尾の改行は削除する", () => {
    const result = write("id: J000001\n\n", "");
    expect(result).toBe("---\nid: J000001\n---\n");
  });
});
