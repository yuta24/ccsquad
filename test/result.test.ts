import { describe, it, expect } from "bun:test";
import { parsePrintOutput, parsePrintOutputFromText, stripAnsi, extractResult } from "../src/infra/stream-parser.js";

describe("parsePrintOutput", () => {
  it("完全な JSON から sessionId, content, costUsd を正しく抽出", () => {
    const json = JSON.stringify({
      session_id: "sess-abc123",
      result: "処理が完了しました",
      cost_usd: 0.0042,
    });
    const result = parsePrintOutput(json);
    expect(result.sessionId).toBe("sess-abc123");
    expect(result.content).toBe("処理が完了しました");
    expect(result.costUsd).toBe(0.0042);
  });

  it("session_id が無い → sessionId は ''", () => {
    const json = JSON.stringify({
      result: "処理が完了しました",
      cost_usd: 0.01,
    });
    const result = parsePrintOutput(json);
    expect(result.sessionId).toBe("");
  });

  it("result が無い → content は ''", () => {
    const json = JSON.stringify({
      session_id: "sess-abc123",
      cost_usd: 0.01,
    });
    const result = parsePrintOutput(json);
    expect(result.content).toBe("");
  });

  it("cost_usd が無い → costUsd は 0", () => {
    const json = JSON.stringify({
      session_id: "sess-abc123",
      result: "処理が完了しました",
    });
    const result = parsePrintOutput(json);
    expect(result.costUsd).toBe(0);
  });

  it("不正な JSON → JSON.parse が例外を投げる", () => {
    expect(() => parsePrintOutput("not valid json")).toThrow();
  });
});

describe("stripAnsi", () => {
  it("CSI エスケープシーケンスを除去", () => {
    expect(stripAnsi("\x1b[32mgreen\x1b[0m")).toBe("green");
  });

  it("複数のCSI シーケンスを除去", () => {
    expect(stripAnsi("\x1b[1m\x1b[31mbold red\x1b[0m normal")).toBe("bold red normal");
  });

  it("OSC エスケープシーケンスを除去", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  it("CSI と OSC の混在", () => {
    expect(stripAnsi("\x1b]0;title\x07\x1b[36mcyan\x1b[0m")).toBe("cyan");
  });

  it("エスケープが無いテキストはそのまま返す", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  it("空文字列はそのまま返す", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("セミコロン付きCSI パラメータを処理", () => {
    expect(stripAnsi("\x1b[38;5;196mred\x1b[0m")).toBe("red");
  });
});

describe("parsePrintOutputFromText", () => {
  it("ターミナルテキストの最終行から JSON をパース", () => {
    const text = `Processing...\nDone.\n${JSON.stringify({ session_id: "sess-123", result: "完了", cost_usd: 0.05 })}`;
    const result = parsePrintOutputFromText(text);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess-123");
    expect(result!.content).toBe("完了");
    expect(result!.costUsd).toBe(0.05);
  });

  it("ANSI エスケープを含むテキストからパース", () => {
    const json = JSON.stringify({ session_id: "sess-456", result: "ok", cost_usd: 0.01 });
    const text = `\x1b[32mSuccess\x1b[0m\n${json}`;
    const result = parsePrintOutputFromText(text);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess-456");
  });

  it("JSON が無い場合 → null", () => {
    const text = "plain text output\nno json here";
    const result = parsePrintOutputFromText(text);
    expect(result).toBeNull();
  });

  it("session_id も result も無い JSON → null", () => {
    const text = '{"foo":"bar"}';
    const result = parsePrintOutputFromText(text);
    expect(result).toBeNull();
  });

  it("空文字列 → null", () => {
    const result = parsePrintOutputFromText("");
    expect(result).toBeNull();
  });

  it("result のみの JSON でもパース可能", () => {
    const text = `output\n${JSON.stringify({ result: "内容" })}`;
    const result = parsePrintOutputFromText(text);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("内容");
    expect(result!.sessionId).toBe("");
  });

  it("複数の JSON 行がある場合末尾を優先", () => {
    const json1 = JSON.stringify({ session_id: "first", result: "古い" });
    const json2 = JSON.stringify({ session_id: "second", result: "新しい" });
    const text = `${json1}\nsome output\n${json2}`;
    const result = parsePrintOutputFromText(text);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("second");
    expect(result!.content).toBe("新しい");
  });

  it("JSON の前にスペースがある場合もパース可能", () => {
    const json = JSON.stringify({ session_id: "sess-789", result: "ok" });
    const text = `output\n   ${json}`;
    const result = parsePrintOutputFromText(text);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess-789");
  });

  it("不完全な JSON 行はスキップして有効な行を返す", () => {
    const validJson = JSON.stringify({ session_id: "valid", result: "ok" });
    const text = `${validJson}\n{broken json\n{"no_match": true}`;
    const result = parsePrintOutputFromText(text);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("valid");
  });

  it("OSC エスケープを含むターミナル出力からパース", () => {
    const json = JSON.stringify({ session_id: "sess-osc", result: "done", cost_usd: 0.1 });
    const text = `\x1b]0;Claude Code\x07\x1b[32mDone\x1b[0m\n${json}`;
    const result = parsePrintOutputFromText(text);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess-osc");
    expect(result!.costUsd).toBe(0.1);
  });

  it("末尾に空行がある場合もパース可能", () => {
    const json = JSON.stringify({ session_id: "sess-trail", result: "ok" });
    const text = `output\n${json}\n\n\n`;
    const result = parsePrintOutputFromText(text);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess-trail");
  });
});

describe("extractResult", () => {
  it("末尾行に JSON がある場合に正しく抽出", () => {
    const message = `some output\n{"job_id":"J000001","result":"success","message":"完了"}`;
    const result = extractResult(message);
    expect(result).not.toBeNull();
    expect(result!.job_id).toBe("J000001");
    expect(result!.result).toBe("success");
    expect(result!.message).toBe("完了");
  });

  it("中間行にも JSON があるが末尾を優先", () => {
    const message = [
      '{"job_id":"J000001","result":"intermediate","message":"中間"}',
      "some other output",
      '{"job_id":"J000002","result":"final","message":"最終"}',
    ].join("\n");
    const result = extractResult(message);
    expect(result).not.toBeNull();
    expect(result!.job_id).toBe("J000002");
    expect(result!.result).toBe("final");
  });

  it("JSON が無い場合 → null を返す", () => {
    const message = "plain text output\nno json here";
    const result = extractResult(message);
    expect(result).toBeNull();
  });

  it("JSON があるが job_id が無い → null を返す", () => {
    const message = '{"result":"success","message":"完了"}';
    const result = extractResult(message);
    expect(result).toBeNull();
  });

  it("空文字列 → null を返す", () => {
    const result = extractResult("");
    expect(result).toBeNull();
  });
});
