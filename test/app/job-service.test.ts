import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { replaceDescriptionSection, JobService } from "../../src/app/job-service.js";
import { CcsquadError } from "../../src/error.js";
import { createTestContext } from "../helpers.js";
import { parseWorkflowObject } from "../../src/domain/workflow.js";
import type { ProjectContext } from "../../src/app/project-context.js";

const BASIC_WF = parseWorkflowObject({
  plan: { type: "plan", agent: "developer", on: { completed: "execute", failed: "ABORT" } },
  execute: { type: "execute", agent: "developer", on: { completed: "review", failed: "plan" } },
  review: { type: "review", agent: "reviewer", on: { approved: "COMPLETE", rejected: "execute" } },
});

describe("JobService.start — 依存関係チェック", () => {
  let ctx: ProjectContext;

  afterEach(() => {
    rmSync(ctx.projectRoot, { recursive: true, force: true });
  });

  it("依存先が aborted のとき start でエラーになる", () => {
    ctx = createTestContext();
    const svc = new JobService(ctx);
    const dep = svc.create("依存先", BASIC_WF);
    dep.frontmatter.status = "aborted";
    ctx.jobStore.save(dep);

    const child = svc.create("子ジョブ", BASIC_WF, { dependsOn: [dep.frontmatter.id] });
    expect(() => svc.start(child.frontmatter.id)).toThrow(CcsquadError);
  });

  it("依存先が failed のとき start でエラーになる", () => {
    ctx = createTestContext();
    const svc = new JobService(ctx);
    const dep = svc.create("依存先", BASIC_WF);
    dep.frontmatter.status = "failed";
    ctx.jobStore.save(dep);

    const child = svc.create("子ジョブ", BASIC_WF, { dependsOn: [dep.frontmatter.id] });
    expect(() => svc.start(child.frontmatter.id)).toThrow(CcsquadError);
  });

  it("依存先が aborted のとき、エラーメッセージに delete コマンドが含まれる", () => {
    ctx = createTestContext();
    const svc = new JobService(ctx);
    const dep = svc.create("依存先", BASIC_WF);
    dep.frontmatter.status = "aborted";
    ctx.jobStore.save(dep);

    const child = svc.create("子ジョブ", BASIC_WF, { dependsOn: [dep.frontmatter.id] });
    expect(() => svc.start(child.frontmatter.id)).toThrow(/ccsquad delete/);
  });

  it("依存先が completed なら start できる", () => {
    ctx = createTestContext();
    const svc = new JobService(ctx);
    const dep = svc.create("依存先", BASIC_WF);
    dep.frontmatter.status = "completed";
    ctx.jobStore.save(dep);

    const child = svc.create("子ジョブ", BASIC_WF, { dependsOn: [dep.frontmatter.id] });
    expect(() => svc.start(child.frontmatter.id)).not.toThrow();
  });
});

describe("JobService.transition — --workflow による動的ワークフロー変更", () => {
  let ctx: ProjectContext;

  afterEach(() => {
    rmSync(ctx.projectRoot, { recursive: true, force: true });
  });

  it("plan done 時に新しいワークフローに切り替わる", () => {
    ctx = createTestContext();
    const svc = new JobService(ctx);
    const job = svc.create("テスト", BASIC_WF, {
      acceptanceCriteria: [{ description: "AC1", done: false }],
    });
    svc.start(job.frontmatter.id);

    const newWf = parseWorkflowObject({
      plan: { type: "plan", agent: "plan", on: { completed: "custom", failed: "ABORT" } },
      custom: { type: "execute", agent: "custom-agent", on: { completed: "COMPLETE", failed: "plan" } },
    });

    svc.transition(job.frontmatter.id, "completed", "計画完了", newWf);

    const updated = ctx.jobStore.load(job.frontmatter.id);
    expect(updated.frontmatter.current_phase).toBe("custom");
    expect(updated.frontmatter.workflow.phases.find((p) => p.name === "custom")?.agent).toBe("custom-agent");
  });

  it("--workflow なしの場合は元のワークフローを維持する", () => {
    ctx = createTestContext();
    const svc = new JobService(ctx);
    const job = svc.create("テスト", BASIC_WF, {
      acceptanceCriteria: [{ description: "AC1", done: false }],
    });
    svc.start(job.frontmatter.id);

    svc.transition(job.frontmatter.id, "completed", "計画完了");

    const updated = ctx.jobStore.load(job.frontmatter.id);
    expect(updated.frontmatter.current_phase).toBe("execute");
    expect(updated.frontmatter.workflow.phases).toHaveLength(3);
  });

  it("新ワークフローに現在フェーズがなければエラー", () => {
    ctx = createTestContext();
    const svc = new JobService(ctx);
    const job = svc.create("テスト", BASIC_WF, {
      acceptanceCriteria: [{ description: "AC1", done: false }],
    });
    svc.start(job.frontmatter.id);

    const invalidWf = parseWorkflowObject({
      other: { type: "execute", agent: "developer", on: { completed: "COMPLETE", failed: "ABORT" } },
    });

    expect(() => svc.transition(job.frontmatter.id, "completed", "計画完了", invalidWf)).toThrow(CcsquadError);
  });

  it("plan 以外のフェーズで --workflow を指定するとエラー", () => {
    ctx = createTestContext();
    const svc = new JobService(ctx);
    const job = svc.create("テスト", BASIC_WF, {
      acceptanceCriteria: [{ description: "AC1", done: false }],
    });
    svc.start(job.frontmatter.id);
    // plan → execute に遷移
    svc.transition(job.frontmatter.id, "completed", "計画完了");

    const newWf = parseWorkflowObject({
      execute: { type: "execute", agent: "developer", on: { completed: "COMPLETE", failed: "ABORT" } },
    });

    expect(() => svc.transition(job.frontmatter.id, "completed", "実装完了", newWf))
      .toThrow(/plan フェーズでのみ許可/);
  });
});

describe("replaceDescriptionSection", () => {
  it("既存の ## 説明 セクションを置換する", () => {
    const body = "## 説明\n旧説明文\n";
    const result = replaceDescriptionSection(body, "新説明文");
    expect(result).toBe("## 説明\n新説明文\n");
  });

  it("body が空の場合は新しいセクションを追加する", () => {
    const result = replaceDescriptionSection("", "説明文");
    expect(result).toBe("## 説明\n説明文\n");
  });

  it("## 説明 がない場合は先頭に追記する", () => {
    const body = "## 他のセクション\n内容\n";
    const result = replaceDescriptionSection(body, "説明文");
    expect(result).toBe("## 説明\n説明文\n## 他のセクション\n内容\n");
  });

  it("## 説明 が途中にある場合（前置きあり）も置換できる", () => {
    const body = "前置き\n## 説明\n旧説明文\n";
    const result = replaceDescriptionSection(body, "新説明文");
    expect(result).toBe("前置き\n## 説明\n新説明文\n");
  });

  it("## 説明 の後に別のセクションがある場合は説明部分のみ置換する", () => {
    const body = "## 説明\n旧説明文\n## 別セクション\n内容\n";
    const result = replaceDescriptionSection(body, "新説明文");
    expect(result).toBe("## 説明\n新説明文\n## 別セクション\n内容\n");
  });

  it("## 説明 と次セクションの間に空行がある場合も置換する", () => {
    const body = "## 説明\n旧説明文\n\n## 別セクション\n内容\n";
    const result = replaceDescriptionSection(body, "新説明文");
    expect(result).toBe("## 説明\n新説明文\n## 別セクション\n内容\n");
  });

  it("複数行の説明文を置換できる", () => {
    const body = "## 説明\n行1\n行2\n行3\n";
    const result = replaceDescriptionSection(body, "新しい説明");
    expect(result).toBe("## 説明\n新しい説明\n");
  });

  it("置換後の説明が複数行でも正しく書き込まれる", () => {
    const body = "## 説明\n旧説明文\n";
    const result = replaceDescriptionSection(body, "行1\n行2\n行3");
    expect(result).toBe("## 説明\n行1\n行2\n行3\n");
  });
});
