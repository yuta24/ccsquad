import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore } from "../src/infra/log-store.js";

function makeLogStore(): LogStore {
  const dir = mkdtempSync(join(tmpdir(), "ccsquad-log-test-"));
  return new LogStore(join(dir, "logs"));
}

describe("LogStore", () => {
  it("ログが存在しない場合 null を返す", () => {
    const store = makeLogStore();
    expect(store.read("J000001")).toBeNull();
  });

  it("append でログを書き込み、read で取得できる", () => {
    const store = makeLogStore();
    store.append("J000001", "plan", "設計方針を決定しました");
    const content = store.read("J000001");
    expect(content).not.toBeNull();
    expect(content).toContain("[plan]");
    expect(content).toContain("設計方針を決定しました");
  });

  it("複数回 append すると追記される", () => {
    const store = makeLogStore();
    store.append("J000001", "plan", "最初のエントリ");
    store.append("J000001", "execute", "2番目のエントリ");
    const content = store.read("J000001");
    expect(content).toContain("最初のエントリ");
    expect(content).toContain("2番目のエントリ");
    expect(content).toContain("[plan]");
    expect(content).toContain("[execute]");
  });

  it("異なるジョブのログは独立している", () => {
    const store = makeLogStore();
    store.append("J000001", "plan", "ジョブ1のログ");
    store.append("J000002", "plan", "ジョブ2のログ");
    expect(store.read("J000001")).toContain("ジョブ1のログ");
    expect(store.read("J000001")).not.toContain("ジョブ2のログ");
    expect(store.read("J000002")).toContain("ジョブ2のログ");
  });

  it("logPath がジョブIDに対応するパスを返す", () => {
    const store = makeLogStore();
    expect(store.logPath("J000001")).toContain("J000001.md");
  });

  it("不正なジョブ ID はログパスとして扱わずエラー", () => {
    const store = makeLogStore();
    expect(() => store.read("../J000001")).toThrow(/不正なジョブ ID/);
    expect(() => store.append("../J000001", "plan", "message")).toThrow(/不正なジョブ ID/);
  });
});
