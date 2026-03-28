import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputStore } from "../src/infra/output-store.js";
import type { NodeOutput } from "../src/domain/types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ccsquad-output-test-"));
}

function makeOutput(phase: string, iteration = 1, content = "テスト出力"): Omit<NodeOutput, "seq"> {
  return {
    phase,
    executor: "test-agent",
    result: "completed",
    iteration,
    timestamp: new Date().toISOString(),
    content,
  };
}

describe("OutputStore.save", () => {
  it("出力ファイルを保存する", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan"));

    const outputs = store.loadForJob("J000001");
    expect(outputs.length).toBe(1);
  });

  it("保存した出力の内容が正しい", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan", 1, "計画フェーズの出力"));

    const outputs = store.loadForJob("J000001");
    expect(outputs[0].phase).toBe("plan");
    expect(outputs[0].executor).toBe("test-agent");
    expect(outputs[0].result).toBe("completed");
    expect(outputs[0].iteration).toBe(1);
    expect(outputs[0].content).toBe("計画フェーズの出力");
  });

  it("複数の出力を保存すると seq が連番になる", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan", 1));
    store.save("J000001", makeOutput("code", 1));
    store.save("J000001", makeOutput("review", 1));

    const outputs = store.loadForJob("J000001");
    expect(outputs.length).toBe(3);
    expect(outputs[0].seq).toBe(1);
    expect(outputs[1].seq).toBe(2);
    expect(outputs[2].seq).toBe(3);
  });

  it("途中のファイルが削除されても seq が衝突しない", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan", 1));
    store.save("J000001", makeOutput("code", 1));
    store.save("J000001", makeOutput("review", 1));

    // 2番目のファイルを手動削除
    const { unlinkSync } = require("node:fs");
    const jobDir = join(dir, "J000001");
    unlinkSync(join(jobDir, "2-code.md"));

    // 次の save は seq=4 になるべき（既存 max=3）
    store.save("J000001", makeOutput("code", 2));
    const outputs = store.loadForJob("J000001");
    const seqs = outputs.map(o => o.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 3, 4]);
  });

  it("sessionId が設定されている場合保存される", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    const output = makeOutput("plan");
    store.save("J000001", { ...output, sessionId: "session-abc" });

    const outputs = store.loadForJob("J000001");
    expect(outputs[0].sessionId).toBe("session-abc");
  });

  it("sessionId が未設定の場合 undefined になる", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan"));

    const outputs = store.loadForJob("J000001");
    expect(outputs[0].sessionId).toBeUndefined();
  });

  it("複数ジョブの出力を独立して保存できる", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan", 1, "ジョブ1の出力"));
    store.save("J000002", makeOutput("plan", 1, "ジョブ2の出力"));

    const outputs1 = store.loadForJob("J000001");
    const outputs2 = store.loadForJob("J000002");
    expect(outputs1.length).toBe(1);
    expect(outputs2.length).toBe(1);
    expect(outputs1[0].content).toBe("ジョブ1の出力");
    expect(outputs2[0].content).toBe("ジョブ2の出力");
  });
});

describe("OutputStore.loadForJob", () => {
  it("存在しないジョブは空配列を返す", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);

    const outputs = store.loadForJob("J999999");
    expect(outputs).toEqual([]);
  });

  it("出力を seq 順にソートして返す", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan"));
    store.save("J000001", makeOutput("code"));
    store.save("J000001", makeOutput("review"));

    const outputs = store.loadForJob("J000001");
    expect(outputs[0].phase).toBe("plan");
    expect(outputs[1].phase).toBe("code");
    expect(outputs[2].phase).toBe("review");
  });
});

describe("OutputStore.latest", () => {
  it("最新の出力を返す", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan", 1, "1回目"));
    store.save("J000001", makeOutput("code", 1, "2回目"));
    store.save("J000001", makeOutput("review", 1, "3回目"));

    const latest = store.latest("J000001");
    expect(latest).toBeDefined();
    expect(latest!.phase).toBe("review");
    expect(latest!.content).toBe("3回目");
  });

  it("出力が存在しない場合 undefined を返す", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);

    const latest = store.latest("J999999");
    expect(latest).toBeUndefined();
  });

  it("1件の場合その出力を返す", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan", 1, "唯一の出力"));

    const latest = store.latest("J000001");
    expect(latest).toBeDefined();
    expect(latest!.content).toBe("唯一の出力");
  });
});

describe("OutputStore.findLastByPhase", () => {
  it("指定フェーズの最後の出力を返す", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan", 1, "plan 1回目"));
    store.save("J000001", makeOutput("code", 1, "code 1回目"));
    store.save("J000001", makeOutput("plan", 2, "plan 2回目"));

    const result = store.findLastByPhase("J000001", "plan");
    expect(result).toBeDefined();
    expect(result!.content).toBe("plan 2回目");
    expect(result!.iteration).toBe(2);
  });

  it("指定フェーズが存在しない場合 undefined を返す", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan", 1));

    const result = store.findLastByPhase("J000001", "nonexistent");
    expect(result).toBeUndefined();
  });

  it("ジョブが存在しない場合 undefined を返す", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);

    const result = store.findLastByPhase("J999999", "plan");
    expect(result).toBeUndefined();
  });

  it("複数ある場合は最後のものを返す", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("code", 1, "code 1"));
    store.save("J000001", makeOutput("code", 2, "code 2"));
    store.save("J000001", makeOutput("code", 3, "code 3"));

    const result = store.findLastByPhase("J000001", "code");
    expect(result!.content).toBe("code 3");
    expect(result!.iteration).toBe(3);
  });
});

describe("OutputStore.listFilesForJob", () => {
  it("ジョブディレクトリが存在しないとき空配列を返す", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);

    const result = store.listFilesForJob("J999999");
    expect(result).toEqual([]);
  });

  it("複数ファイルが存在するとき seq 昇順ソートで返す", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan", 1));
    store.save("J000001", makeOutput("code", 1));
    store.save("J000001", makeOutput("review", 1));

    const result = store.listFilesForJob("J000001");
    expect(result.length).toBe(3);
    expect(result[0].seq).toBe(1);
    expect(result[1].seq).toBe(2);
    expect(result[2].seq).toBe(3);
  });

  it("各エントリに seq, phase, filePath が正しい", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan", 1));
    store.save("J000001", makeOutput("code", 1));

    const result = store.listFilesForJob("J000001");
    expect(result[0].seq).toBe(1);
    expect(result[0].phase).toBe("plan");
    expect(result[0].filePath).toContain("1-plan.md");
    expect(result[1].seq).toBe(2);
    expect(result[1].phase).toBe("code");
    expect(result[1].filePath).toContain("2-code.md");
  });

  it("不正なファイル名は除外される", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan", 1));

    // 不正なファイル名のファイルを直接作成
    const jobDir = join(dir, "J000001");
    writeFileSync(join(jobDir, "invalid-no-seq.md"), "content");
    writeFileSync(join(jobDir, "also-bad.md"), "content");

    const result = store.listFilesForJob("J000001");
    // 正しいファイルのみ返る（不正なファイル名は除外）
    expect(result.length).toBe(1);
    expect(result[0].phase).toBe("plan");
  });
});

describe("OutputStore.remove", () => {
  it("ジョブの出力をすべて削除する", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan"));
    store.save("J000001", makeOutput("code"));
    expect(store.loadForJob("J000001").length).toBe(2);

    store.remove("J000001");
    expect(store.loadForJob("J000001").length).toBe(0);
  });

  it("存在しないジョブを削除してもエラーにならない", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);

    expect(() => store.remove("J999999")).not.toThrow();
  });

  it("別ジョブの出力には影響しない", () => {
    const dir = makeTmpDir();
    const store = new OutputStore(dir);
    store.save("J000001", makeOutput("plan"));
    store.save("J000002", makeOutput("plan"));

    store.remove("J000001");

    expect(store.loadForJob("J000001").length).toBe(0);
    expect(store.loadForJob("J000002").length).toBe(1);
  });
});
