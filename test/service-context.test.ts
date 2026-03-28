import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectContext } from "../src/app/project-context.js";
import { findConfigPath, findConfigPathOrThrow } from "../src/infra/config-loader.js";
import { initialPhase } from "../src/domain/workflow.js";
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
        type: task
        description: 実装計画を策定する
        agent: planner
        on:
          completed: code
          failed: ABORT
      - name: code
        type: task
        description: コードを実装する
        agent: coder
        on:
          completed: COMPLETE
          failed: plan
`;
  writeFileSync(configPath, yaml, "utf-8");
  return configPath;
}

describe("createProjectContext", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  it("全ストアが初期化されたコンテキストを作成する", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createProjectContext(configPath);

    expect(ctx.workflows).toBeDefined();
    expect(ctx.jobStore).toBeDefined();
    expect(ctx.iterationStore).toBeDefined();
    expect(ctx.entryStore).toBeDefined();
    expect(ctx.outputStore).toBeDefined();
    expect(ctx.squadDir).toBeDefined();
    expect(ctx.jobsDir).toBeDefined();
    expect(ctx.memoryDir).toBeDefined();
    expect(ctx.outputsDir).toBeDefined();
  });

  it(".ccsquad/jobs ディレクトリを作成する", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createProjectContext(configPath);

    expect(existsSync(ctx.jobsDir)).toBe(true);
    expect(ctx.jobsDir).toContain(".ccsquad/jobs");
  });

  it(".ccsquad/memory/entries ディレクトリを作成する", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createProjectContext(configPath);

    expect(existsSync(ctx.memoryDir)).toBe(true);
    expect(ctx.memoryDir).toContain(".ccsquad/memory/entries");
  });

  it("設定が正しく読み込まれる", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createProjectContext(configPath);

    const dev = ctx.workflows["dev"];
    expect(dev).toBeDefined();
    expect(dev.phases.length).toBe(2);
    expect(initialPhase(dev).name).toBe("plan");
  });

  it("存在しないファイルパスでエラーをスローする", () => {
    const nonExistentPath = join(tmpDir, "nonexistent.yaml");
    expect(() => createProjectContext(nonExistentPath)).toThrow();
  });

  it("squadDir がプロジェクトルート配下の .ccsquad を指す", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createProjectContext(configPath);

    expect(ctx.squadDir).toBe(join(tmpDir, ".ccsquad"));
  });

  it("jobsDir が squadDir 配下の jobs を指す", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createProjectContext(configPath);

    expect(ctx.jobsDir).toBe(join(tmpDir, ".ccsquad", "jobs"));
  });

  it("memoryDir が squadDir 配下の memory/entries を指す", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createProjectContext(configPath);

    expect(ctx.memoryDir).toBe(join(tmpDir, ".ccsquad", "memory", "entries"));
  });

  it("outputsDir が squadDir 配下の outputs を指す", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createProjectContext(configPath);

    expect(ctx.outputsDir).toBe(join(tmpDir, ".ccsquad", "outputs"));
  });

  it(".ccsquad/outputs ディレクトリを作成する", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createProjectContext(configPath);

    expect(existsSync(ctx.outputsDir)).toBe(true);
    expect(ctx.outputsDir).toContain(".ccsquad/outputs");
  });

  it("outputStore が OutputStore のインスタンスである", () => {
    const configPath = writeValidConfig(tmpDir);
    const ctx = createProjectContext(configPath);

    expect(ctx.outputStore).toBeDefined();
    expect(typeof ctx.outputStore.save).toBe("function");
    expect(typeof ctx.outputStore.loadForJob).toBe("function");
  });
});

describe("findConfigPath", () => {
  it("ccsquad.yaml が存在するディレクトリでパスを返す", () => {
    const dir = makeTempDir();
    writeValidConfig(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const result = findConfigPath();
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
      const result = findConfigPath();
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
      const result = findConfigPath();
      expect(result).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("findConfigPathOrThrow", () => {
  it("ccsquad.yaml が存在しない場合エラーをスローする", () => {
    const dir = makeTempDir();
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(() => findConfigPathOrThrow()).toThrow("ccsquad.yaml が見つかりません");
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
      const result = findConfigPathOrThrow();
      expect(result).toBe(join(dir, "ccsquad.yaml"));
    } finally {
      process.chdir(originalCwd);
    }
  });
});
