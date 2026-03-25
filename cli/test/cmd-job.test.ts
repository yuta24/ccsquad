import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdActivate, cmdDeactivate } from "../src/commands/job.js";
import { CurrentJobsStore } from "../src/current-jobs.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ccsquad-cmd-job-"));
}

describe("cmdActivate / cmdDeactivate", () => {
  it("test_activate_adds_to_store", () => {
    const dir = makeTmpDir();
    cmdActivate(dir, "J000001");
    const store = new CurrentJobsStore(dir);
    expect(store.contains("J000001")).toBe(true);
  });

  it("test_activate_duplicate_is_ok", () => {
    const dir = makeTmpDir();
    cmdActivate(dir, "J000001");
    cmdActivate(dir, "J000001");
    const store = new CurrentJobsStore(dir);
    expect(store.list().length).toBe(1);
  });

  it("test_deactivate_removes_from_store", () => {
    const dir = makeTmpDir();
    const store = new CurrentJobsStore(dir);
    store.add("J000001");
    cmdDeactivate(dir, "J000001");
    expect(store.contains("J000001")).toBe(false);
  });

  it("test_deactivate_nonexistent_is_ok", () => {
    const dir = makeTmpDir();
    expect(() => cmdDeactivate(dir, "J999999")).not.toThrow();
  });
});
