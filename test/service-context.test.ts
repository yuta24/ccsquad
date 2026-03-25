import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, findConfig, findConfigOrThrow } from "../src/service/context.js";
import { CcsquadError } from "../src/error.js";

function makeTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "ccsquad-context-test-")));
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

describe("findConfig", () => {
  it("ccsquad.yaml が存在するディレクトリでパスを返す", () => {
    const dir = makeTempDir();
    writeValidConfig(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const result = findConfig();
      expect(result).toBe(join(dir, "ccsquad.yaml"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("親ディレクトリに ccsquad.yaml がある場合そのパスを返す", () => {
    const dir = makeTempDir();
    writeValidConfig(dir);
    const subDir = join(dir, "subdir");
    mkdirSync(subDir, { recursive: true });
    const originalCwd = process.cwd();
    process.chdir(subDir);
    try {
      const result = findConfig();
      expect(result).toBe(join(dir, "ccsquad.yaml"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("ccsquad.yaml が存在しない場合 null を返す", () => {
    const dir = makeTempDir();
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const result = findConfig();
      expect(result).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("findConfigOrThrow", () => {
  it("ccsquad.yaml が存在しない場合エラーをスローする", () => {
    const dir = makeTempDir();
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(() => findConfigOrThrow()).toThrow("ccsquad.yaml が見つかりません");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("ccsquad.yaml が存在する場合パスを返す", () => {
    const dir = makeTempDir();
    writeValidConfig(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const result = findConfigOrThrow();
      expect(result).toBe(join(dir, "ccsquad.yaml"));
    } finally {
      process.chdir(originalCwd);
    }
  });
});
