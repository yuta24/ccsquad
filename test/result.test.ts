import { describe, it, expect } from "bun:test";
import { parsePrintOutput, extractResult } from "../src/result.js";

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
