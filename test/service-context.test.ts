import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../src/service/context.js";
import { CcsquadError } from "../src/error.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ccsquad-context-test-"));
}

function writeValidConfig(dir: string): string {
  const configPath = join(dir, "ccsquad.yaml");
  const yaml = `
workflows:
  dev:
    description: 開発ワークフロー
    phases:
      - name: plan
        description: 実装計画を策定する
        agent: planner
        on:
          completed: code
          failed: ABORT
      - name: code
        description: コードを実装する
        agent: coder
        on:
          completed: COMPLETE
          failed: plan
`;
  writeFileSync(configPath, yaml, "utf-8");
  return configPath;
}

describe("createContext", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  it("全ストアが初期化されたコンテキストを作成する", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createContext(configPath);

    expect(ctx.config).toBeDefined();
    expect(ctx.store).toBeDefined();
    expect(ctx.iterationStore).toBeDefined();
expect(ctx.entryStore).toBeDefined();
    expect(ctx.squadDir).toBeDefined();
    expect(ctx.jobsDir).toBeDefined();
    expect(ctx.memoryDir).toBeDefined();
  });

  it(".ccsquad/jobs ディレクトリを作成する", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createContext(configPath);

    expect(existsSync(ctx.jobsDir)).toBe(true);
    expect(ctx.jobsDir).toContain(".ccsquad/jobs");
  });

  it(".ccsquad/memory/entries ディレクトリを作成する", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createContext(configPath);

    expect(existsSync(ctx.memoryDir)).toBe(true);
    expect(ctx.memoryDir).toContain(".ccsquad/memory/entries");
  });

  it("設定が正しく読み込まれる", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createContext(configPath);

    const dev = ctx.config.getWorkflow("dev");
    expect(dev).toBeDefined();
    expect(dev!.phases.length).toBe(2);
    expect(dev!.initialPhase().name).toBe("plan");
  });

  it("存在しないファイルパスでエラーをスローする", () => {
    const nonExistentPath = join(tmpDir, "nonexistent.yaml");
    expect(() => createContext(nonExistentPath)).toThrow();
  });

  it("squadDir がプロジェクトルート配下の .ccsquad を指す", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createContext(configPath);

    expect(ctx.squadDir).toBe(join(tmpDir, ".ccsquad"));
  });

  it("jobsDir が squadDir 配下の jobs を指す", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createContext(configPath);

    expect(ctx.jobsDir).toBe(join(tmpDir, ".ccsquad", "jobs"));
  });

  it("memoryDir が squadDir 配下の memory/entries を指す", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createContext(configPath);

    expect(ctx.memoryDir).toBe(join(tmpDir, ".ccsquad", "memory", "entries"));
  });
});
