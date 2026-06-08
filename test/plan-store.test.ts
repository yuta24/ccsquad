import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanStore } from "../src/infra/plan-store.js";

function makePlanStore(): PlanStore {
  const dir = mkdtempSync(join(tmpdir(), "ccsquad-plan-test-"));
  return new PlanStore(join(dir, "plans"));
}

describe("PlanStore", () => {
  it("プランが存在しない場合 null を返す", () => {
    const store = makePlanStore();
    expect(store.read("J000001")).toBeNull();
  });

  it("write でプランを書き込み、read で取得できる", () => {
    const store = makePlanStore();
    store.write("J000001", "## 設計方針\nレイヤードアーキテクチャを採用する。");
    const content = store.read("J000001");
    expect(content).toContain("レイヤードアーキテクチャを採用する。");
  });

  it("再度 write すると上書きされる（追記ではない）", () => {
    const store = makePlanStore();
    store.write("J000001", "最初の計画");
    store.write("J000001", "改訂版の計画");
    const content = store.read("J000001");
    expect(content).toBe("改訂版の計画");
    expect(content).not.toContain("最初の計画");
  });

  it("異なるジョブのプランは独立している", () => {
    const store = makePlanStore();
    store.write("J000001", "ジョブ1の計画");
    store.write("J000002", "ジョブ2の計画");
    expect(store.read("J000001")).toBe("ジョブ1の計画");
    expect(store.read("J000002")).toBe("ジョブ2の計画");
  });

  it("delete でプランを削除できる", () => {
    const store = makePlanStore();
    store.write("J000001", "削除されるべき計画");
    store.delete("J000001");
    expect(store.read("J000001")).toBeNull();
  });

  it("存在しないプランの delete はエラーにならない", () => {
    const store = makePlanStore();
    expect(() => store.delete("J000001")).not.toThrow();
  });

  it("planPath がジョブIDに対応するパスを返す", () => {
    const store = makePlanStore();
    expect(store.planPath("J000001")).toContain("J000001.md");
  });

  it("不正なジョブ ID はパスとして扱わずエラー", () => {
    const store = makePlanStore();
    expect(() => store.read("../J000001")).toThrow(/不正なジョブ ID/);
    expect(() => store.write("../J000001", "x")).toThrow(/不正なジョブ ID/);
    expect(() => store.delete("../J000001")).toThrow(/不正なジョブ ID/);
  });
});
