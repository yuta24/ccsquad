import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IterationStore } from "../src/infra/iteration-store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ccsquad-iteration-"));
}

describe("IterationStore", () => {
  it("test_get_returns_zero_for_unknown", () => {
    const dir = makeTmpDir();
    const store = new IterationStore(dir);
    expect(store.get("J000001")).toBe(0);
  });

  it("test_increment", () => {
    const dir = makeTmpDir();
    const store = new IterationStore(dir);
    expect(store.increment("J000001")).toBe(1);
    expect(store.increment("J000001")).toBe(2);
    expect(store.increment("J000001")).toBe(3);
    expect(store.get("J000001")).toBe(3);
  });

  it("test_reset", () => {
    const dir = makeTmpDir();
    const store = new IterationStore(dir);
    store.increment("J000001");
    store.increment("J000001");
    store.reset("J000001");
    expect(store.get("J000001")).toBe(0);
  });

  it("test_remove", () => {
    const dir = makeTmpDir();
    const store = new IterationStore(dir);
    store.increment("J000001");
    store.remove("J000001");
    expect(store.get("J000001")).toBe(0);
  });

  it("test_multiple_jobs", () => {
    const dir = makeTmpDir();
    const store = new IterationStore(dir);
    store.increment("J000001");
    store.increment("J000001");
    store.increment("J000002");
    expect(store.get("J000001")).toBe(2);
    expect(store.get("J000002")).toBe(1);
  });
});
