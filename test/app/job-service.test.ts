import { describe, it, expect } from "bun:test";
import { replaceDescriptionSection } from "../../src/app/job-service.js";

describe("replaceDescriptionSection", () => {
  it("既存の ## 説明 セクションを置換する", () => {
    const body = "## 説明\n旧説明文\n";
    const result = replaceDescriptionSection(body, "新説明文");
    expect(result).toBe("## 説明\n新説明文\n");
  });

  it("body が空の場合は新しいセクションを追加する", () => {
    const result = replaceDescriptionSection("", "説明文");
    expect(result).toBe("## 説明\n説明文\n");
  });

  it("## 説明 がない場合は先頭に追記する", () => {
    const body = "## 他のセクション\n内容\n";
    const result = replaceDescriptionSection(body, "説明文");
    expect(result).toBe("## 説明\n説明文\n## 他のセクション\n内容\n");
  });

  it("## 説明 が途中にある場合（前置きあり）も置換できる", () => {
    const body = "前置き\n## 説明\n旧説明文\n";
    const result = replaceDescriptionSection(body, "新説明文");
    expect(result).toBe("前置き\n## 説明\n新説明文\n");
  });

  it("## 説明 の後に別のセクションがある場合は説明部分のみ置換する", () => {
    const body = "## 説明\n旧説明文\n## 別セクション\n内容\n";
    const result = replaceDescriptionSection(body, "新説明文");
    expect(result).toBe("## 説明\n新説明文\n## 別セクション\n内容\n");
  });

  it("## 説明 と次セクションの間に空行がある場合も置換する", () => {
    const body = "## 説明\n旧説明文\n\n## 別セクション\n内容\n";
    const result = replaceDescriptionSection(body, "新説明文");
    expect(result).toBe("## 説明\n新説明文\n## 別セクション\n内容\n");
  });

  it("複数行の説明文を置換できる", () => {
    const body = "## 説明\n行1\n行2\n行3\n";
    const result = replaceDescriptionSection(body, "新しい説明");
    expect(result).toBe("## 説明\n新しい説明\n");
  });

  it("置換後の説明が複数行でも正しく書き込まれる", () => {
    const body = "## 説明\n旧説明文\n";
    const result = replaceDescriptionSection(body, "行1\n行2\n行3");
    expect(result).toBe("## 説明\n行1\n行2\n行3\n");
  });
});
