import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectContext } from "../src/app/project-context.js";

function makeTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "ccsquad-context-test-")));
}

describe("createProjectContext", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  it("CCSQUAD_ROOT 環境変数でプロジェクトルートを指定できる", () => {
    const originalRoot = process.env.CCSQUAD_ROOT;
    process.env.CCSQUAD_ROOT = tmpDir;
    try {
      const ctx = createProjectContext();

      expect(ctx.jobStore).toBeDefined();
      expect(ctx.projectRoot).toBe(tmpDir);
      expect(ctx.squadDir).toBe(join(tmpDir, ".ccsquad"));
      expect(ctx.jobsDir).toBe(join(tmpDir, ".ccsquad", "jobs"));
    } finally {
      if (originalRoot !== undefined) {
        process.env.CCSQUAD_ROOT = originalRoot;
      } else {
        delete process.env.CCSQUAD_ROOT;
      }
    }
  });

  it(".ccsquad/jobs ディレクトリを作成する", () => {
    const originalRoot = process.env.CCSQUAD_ROOT;
    process.env.CCSQUAD_ROOT = tmpDir;
    try {
      const ctx = createProjectContext();
      expect(existsSync(ctx.jobsDir)).toBe(true);
    } finally {
      if (originalRoot !== undefined) {
        process.env.CCSQUAD_ROOT = originalRoot;
      } else {
        delete process.env.CCSQUAD_ROOT;
      }
    }
  });

  it(".ccsquad ディレクトリがある場所をプロジェクトルートとして発見する", () => {
    mkdirSync(join(tmpDir, ".ccsquad"), { recursive: true });
    const subDir = join(tmpDir, "sub", "deep");
    mkdirSync(subDir, { recursive: true });

    const originalRoot = process.env.CCSQUAD_ROOT;
    delete process.env.CCSQUAD_ROOT;
    const originalCwd = process.cwd();
    process.chdir(subDir);
    try {
      const ctx = createProjectContext();
      expect(ctx.projectRoot).toBe(tmpDir);
    } finally {
      process.chdir(originalCwd);
      if (originalRoot !== undefined) {
        process.env.CCSQUAD_ROOT = originalRoot;
      }
    }
  });
});
