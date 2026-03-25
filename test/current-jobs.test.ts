import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CurrentJobsStore } from "../src/current-jobs.js";
import { CcsquadError } from "../src/error.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ccsquad-current-jobs-"));
}

describe("CurrentJobsStore", () => {
  it("test_add_and_contains", () => {
    const dir = makeTmpDir();
    const store = new CurrentJobsStore(dir);
    expect(store.contains("J000001")).toBe(false);
    store.add("J000001");
    expect(store.contains("J000001")).toBe(true);
  });

  it("test_add_duplicate_ignored", () => {
    const dir = makeTmpDir();
    const store = new CurrentJobsStore(dir);
    store.add("J000001");
    store.add("J000001");
    expect(store.list().length).toBe(1);
  });

  it("test_remove", () => {
    const dir = makeTmpDir();
    const store = new CurrentJobsStore(dir);
    store.add("J000001");
    store.remove("J000001");
    expect(store.contains("J000001")).toBe(false);
    // File should be deleted when empty
    expect(existsSync(join(dir, "current-jobs.json"))).toBe(false);
  });

  it("test_remove_nonexistent", () => {
    const dir = makeTmpDir();
    const store = new CurrentJobsStore(dir);
    // Should not throw
    expect(() => store.remove("J999999")).not.toThrow();
  });

  it("test_multiple_jobs", () => {
    const dir = makeTmpDir();
    const store = new CurrentJobsStore(dir);
    store.add("J000001");
    store.add("J000002");
    store.add("J000003");
    expect(store.list().length).toBe(3);
    store.remove("J000002");
    const remaining = store.list();
    expect(remaining.length).toBe(2);
    expect(remaining).toContain("J000001");
    expect(remaining).toContain("J000003");
  });

  it("test_list_empty", () => {
    const dir = makeTmpDir();
    const store = new CurrentJobsStore(dir);
    expect(store.list()).toEqual([]);
  });

  it("test_corrupted_json_returns_error", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "current-jobs.json"), "not valid json", "utf-8");
    const store = new CurrentJobsStore(dir);
    expect(() => store.list()).toThrow(CcsquadError);
    expect(() => store.add("J000001")).toThrow(CcsquadError);
    expect(() => store.contains("J000001")).toThrow(CcsquadError);
    expect(() => store.remove("J000001")).toThrow(CcsquadError);
  });

  it("test_non_array_json_returns_error", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "current-jobs.json"), '{"key": "value"}', "utf-8");
    const store = new CurrentJobsStore(dir);
    expect(() => store.list()).toThrow(CcsquadError);
  });
});
