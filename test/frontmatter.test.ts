import { describe, it, expect } from "bun:test";
import { parse, write } from "../src/infra/frontmatter.js";

describe("frontmatter", () => {
  describe("parse", () => {
    it("正常なfrontmatterをパースする", () => {
      const content = "---\ntitle: test\nstatus: pending\n---\n## 説明\nこれはテストです。\n";
      const { yaml, body } = parse(content);
      expect(yaml).toBe("title: test\nstatus: pending");
      expect(body).toBe("## 説明\nこれはテストです。\n");
    });

    it("bodyがない場合", () => {
      const content = "---\ntitle: test\n---\n";
      const { yaml, body } = parse(content);
      expect(yaml).toBe("title: test");
      expect(body).toBe("");
    });

    it("frontmatterがない場合はエラー", () => {
      const content = "just some text";
      expect(() => parse(content)).toThrow();
    });

    it("終端デリミタがない場合はエラー", () => {
      const content = "---\ntitle: test\n";
      expect(() => parse(content)).toThrow();
    });
  });

  describe("write", () => {
    it("bodyありで書き出す", () => {
      const result = write("title: test", "## 説明\nこれはテストです。\n");
      expect(result).toBe("---\ntitle: test\n---\n## 説明\nこれはテストです。\n");
    });

    it("bodyなしで書き出す", () => {
      const result = write("title: test", "");
      expect(result).toBe("---\ntitle: test\n---\n");
    });
  });

  describe("roundtrip", () => {
    it("write→parseで元に戻る", () => {
      const yaml = "title: test\nstatus: pending";
      const body = "## 説明\nこれはテストです。\n";
      const written = write(yaml, body);
      const parsed = parse(written);
      expect(parsed.yaml).toBe(yaml);
      expect(parsed.body).toBe(body);
    });
  });
});
