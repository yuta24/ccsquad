import { describe, it, expect } from "bun:test";
import { extractResult } from "../src/commands/hook.js";

describe("extractResult", () => {
  it("test_extract_result_completed", () => {
    const msg =
      "実装が完了しました。テストも通過しています。\n" +
      '{"job_id": "J000001", "result": "completed", "message": "認証機能を実装しました"}';
    const result = extractResult(msg);
    expect(result).not.toBeNull();
    expect(result!.job_id).toBe("J000001");
    expect(result!.result).toBe("completed");
    expect(result!.message).toBe("認証機能を実装しました");
  });

  it("test_extract_result_approved", () => {
    const msg =
      "コードレビューを完了しました。問題ありません。\n" +
      '{"job_id": "J000002", "result": "approved", "message": "LGTM"}';
    const result = extractResult(msg);
    expect(result).not.toBeNull();
    expect(result!.job_id).toBe("J000002");
    expect(result!.result).toBe("approved");
    expect(result!.message).toBe("LGTM");
  });

  it("test_extract_result_rejected", () => {
    const msg =
      "いくつかの問題が見つかりました。\n" +
      '{"job_id": "J000001", "result": "rejected", "message": "テストカバレッジが不足しています"}';
    const result = extractResult(msg);
    expect(result).not.toBeNull();
    expect(result!.job_id).toBe("J000001");
    expect(result!.result).toBe("rejected");
  });

  it("test_extract_result_no_json", () => {
    const msg = "テキストのみのメッセージです。";
    expect(extractResult(msg)).toBeNull();
  });

  it("test_extract_result_last_json_wins", () => {
    const msg =
      "途中経過:\n" +
      '{"job_id": "J000001", "result": "failed", "message": "ビルドエラー"}\n' +
      "修正しました:\n" +
      '{"job_id": "J000001", "result": "completed", "message": "修正完了"}';
    const result = extractResult(msg);
    expect(result).not.toBeNull();
    expect(result!.result).toBe("completed");
  });

  it("test_extract_result_missing_job_id_returns_none", () => {
    const msg =
      "旧フォーマット:\n" +
      '{"result": "completed", "message": "完了しました"}';
    expect(extractResult(msg)).toBeNull();
  });
});
