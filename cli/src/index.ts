#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Command } from "commander";

import { SquadConfigImpl } from "./config.js";
import { JobStore, appendPhaseLog } from "./job.js";
import { WorkflowEngine, checkCircularDependency } from "./engine.js";
import { IterationStore } from "./iteration.js";
import { CurrentJobsStore } from "./current-jobs.js";
import { EntryStore } from "./entry.js";
import { CcsquadError } from "./error.js";
import { parseTransitionCondition } from "./config.js";
import {
  cmdAdd as memoryCmdAdd,
  cmdList as memoryCmdList,
  cmdShow as memoryCmdShow,
  cmdEdit as memoryCmdEdit,
  cmdDelete as memoryCmdDelete,
  cmdSearch as memoryCmdSearch,
} from "./commands/memory.js";
import { cmdActivate, cmdDeactivate } from "./commands/job.js";
import { cmdOnAgentComplete } from "./commands/hook.js";
import { cmdSetup } from "./commands/setup.js";

// --- Config lookup ---

function findConfig(): string {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, "ccsquad.yaml");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new CcsquadError("config", "ccsquad.yaml が見つかりません");
    }
    dir = parent;
  }
}

interface Context {
  config: ReturnType<typeof SquadConfigImpl.load>;
  store: JobStore;
  iterationStore: IterationStore;
  entryStore: EntryStore;
  squadDir: string;
  jobsDir: string;
  memoryDir: string;
}

function getContext(): Context {
  const configPath = findConfig();
  const config = SquadConfigImpl.load(configPath);
  const projectRoot = dirname(configPath);
  const squadDir = join(projectRoot, ".ccsquad");
  const jobsDir = join(squadDir, "jobs");
  const memoryDir = join(squadDir, "memory", "entries");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });

  const store = new JobStore(jobsDir);
  const iterationStore = new IterationStore(squadDir);
  const entryStore = new EntryStore(memoryDir);

  return { config, store, iterationStore, entryStore, squadDir, jobsDir, memoryDir };
}

// --- Job command helpers ---

function truncate(s: string, maxLen: number): string {
  if ([...s].length <= maxLen) return s;
  return [...s].slice(0, maxLen - 2).join("") + "..";
}

function getWorkflow(config: ReturnType<typeof SquadConfigImpl.load>, workflowName: string) {
  const wf = config.getWorkflow(workflowName);
  if (!wf) {
    throw new CcsquadError("config", `ワークフロー '${workflowName}' が ccsquad.yaml に定義されていません`);
  }
  return wf;
}

function printTransitionResult(job: ReturnType<JobStore["load"]>): void {
  const fm = job.frontmatter;
  if (fm.status === "completed") {
    console.log(`ジョブが完了しました: ${fm.id}`);
  } else if (fm.status === "failed") {
    console.log(`ジョブが失敗しました: ${fm.id}`);
  } else if (fm.status === "running") {
    const phase = fm.current_phase ?? "?";
    console.log(`フェーズを遷移しました: ${fm.id} → ${phase}`);
  } else if (fm.status === "closed") {
    console.log(`ジョブがクローズされました: ${fm.id}`);
  }
}

// --- Main ---

const program = new Command();
program.name("ccsquad").description("ジョブ管理 + ワークフローエンジン + メモリ管理 CLI");

// ===== job commands =====
const jobCmd = program.command("job").description("ジョブ管理");

jobCmd
  .command("list")
  .description("ジョブ一覧を表示")
  .action(() => {
    const { store } = getContext();
    const jobs = store.listAll();
    if (jobs.length === 0) {
      console.log("ジョブはありません。");
      return;
    }
    console.log(
      `${"ID".padEnd(10)} ${"タイトル".padEnd(30)} ${"ワークフロー".padEnd(10)} ${"ステータス".padEnd(12)} ${"フェーズ".padEnd(12)} ${"優先度".padEnd(4)}`,
    );
    console.log("-".repeat(80));
    for (const job of jobs) {
      const fm = job.frontmatter;
      console.log(
        `${fm.id.padEnd(10)} ${truncate(fm.title, 28).padEnd(30)} ${fm.workflow.padEnd(10)} ${fm.status.padEnd(12)} ${(fm.current_phase ?? "-").padEnd(12)} ${String(fm.priority).padEnd(4)}`,
      );
    }
  });

jobCmd
  .command("show <id>")
  .description("ジョブ詳細を表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((id: string, options: { format: string }) => {
    const { config, store } = getContext();
    const job = store.load(id);
    const format = options.format === "json" ? "json" : "text";

    if (format === "json") {
      const wf = config.getWorkflow(job.frontmatter.workflow);
      let phaseConfig: { description?: string; agent?: string; reviewer?: string } | null = null;
      if (wf && job.frontmatter.current_phase) {
        const phase = wf.getPhase(job.frontmatter.current_phase);
        if (phase) {
          phaseConfig = {
            description: phase.description,
            agent: phase.agent,
            reviewer: phase.reviewer,
          };
        }
      }

      const output: Record<string, unknown> = {
        id: job.frontmatter.id,
        title: job.frontmatter.title,
        workflow: job.frontmatter.workflow,
        status: job.frontmatter.status,
        priority: job.frontmatter.priority,
        depends_on: job.frontmatter.depends_on ?? [],
        created_at: job.frontmatter.created_at,
        updated_at: job.frontmatter.updated_at,
        body: job.body,
      };
      if (job.frontmatter.current_phase !== undefined) {
        output["current_phase"] = job.frontmatter.current_phase;
      }
      if (phaseConfig !== null) {
        output["phase_config"] = phaseConfig;
      }
      console.log(JSON.stringify(output, null, 2));
    } else {
      const fm = job.frontmatter;
      console.log(`${fm.id}: ${fm.title}`);
      console.log(`ワークフロー: ${fm.workflow}`);
      console.log(`ステータス: ${fm.status}`);
      if (fm.current_phase) {
        console.log(`現在のフェーズ: ${fm.current_phase}`);
        const wf = config.getWorkflow(fm.workflow);
        if (wf) {
          const phase = wf.getPhase(fm.current_phase);
          if (phase) {
            if (phase.description) console.log(`  説明: ${phase.description}`);
            if (phase.agent) console.log(`  エージェント: ${phase.agent}`);
            if (phase.reviewer) console.log(`  レビュアー: ${phase.reviewer}`);
          }
        }
      }
      console.log(`優先度: ${fm.priority}`);
      const dependsOn = fm.depends_on ?? [];
      if (dependsOn.length > 0) {
        console.log(`依存: ${dependsOn.join(", ")}`);
      }
      console.log(`作成日時: ${fm.created_at}`);
      console.log(`更新日時: ${fm.updated_at}`);
      if (job.body.length > 0) {
        console.log();
        process.stdout.write(job.body);
      }
    }
  });

jobCmd
  .command("add <title>")
  .description("ジョブを追加")
  .requiredOption("--workflow <workflow>", "ワークフロー名")
  .option("--description <description>", "説明")
  .option("--priority <priority>", "優先度", "0")
  .option("--depends-on <ids>", "依存ジョブ ID (カンマ区切り)")
  .action((title: string, options: { workflow: string; description?: string; priority: string; dependsOn?: string }) => {
    const { config, store } = getContext();

    if (!config.getWorkflow(options.workflow)) {
      throw new CcsquadError("config", `ワークフロー '${options.workflow}' が ccsquad.yaml に定義されていません`);
    }

    const id = store.nextId();
    const priority = parseInt(options.priority, 10) || 0;
    const dependsOn: string[] = options.dependsOn ? options.dependsOn.split(",").map((s) => s.trim()).filter(Boolean) : [];

    if (dependsOn.length > 0) {
      for (const depId of dependsOn) {
        store.load(depId); // throws if not found
      }
      checkCircularDependency(store, id, dependsOn);
    }

    const now = new Date().toISOString();
    const body = options.description ? `## 説明\n${options.description}\n` : "";

    store.save({
      frontmatter: {
        id,
        title,
        workflow: options.workflow,
        status: "pending",
        current_phase: undefined,
        priority,
        depends_on: dependsOn,
        created_at: now,
        updated_at: now,
      },
      body,
    });
    console.log(`ジョブを作成しました: ${id}`);
  });

jobCmd
  .command("edit <id>")
  .description("ジョブを編集")
  .option("--title <title>", "タイトル")
  .option("--description <description>", "説明")
  .option("--priority <priority>", "優先度")
  .option("--depends-on <ids>", "依存ジョブ ID (カンマ区切り)")
  .action((id: string, options: { title?: string; description?: string; priority?: string; dependsOn?: string }) => {
    const { store } = getContext();
    const job = store.load(id);

    if (options.title !== undefined) {
      job.frontmatter.title = options.title;
    }
    if (options.priority !== undefined) {
      job.frontmatter.priority = parseInt(options.priority, 10) || 0;
    }
    if (options.dependsOn !== undefined) {
      const dependsOn = options.dependsOn.split(",").map((s) => s.trim()).filter(Boolean);
      for (const depId of dependsOn) {
        store.load(depId);
      }
      checkCircularDependency(store, id, dependsOn);
      job.frontmatter.depends_on = dependsOn;
    }
    if (options.description !== undefined) {
      const desc = options.description;
      const marker = "## 説明\n";
      const start = job.body.indexOf(marker);
      if (start !== -1) {
        const sectionEnd = job.body.indexOf("\n## ", start + marker.length);
        const before = job.body.slice(0, start);
        const after = sectionEnd !== -1 ? job.body.slice(sectionEnd) : "";
        job.body = `${before}${marker}${desc}\n${after}`;
      } else {
        job.body = `${marker}${desc}\n${job.body}`;
      }
    }

    job.frontmatter.updated_at = new Date().toISOString();
    store.save(job);
    console.log(`ジョブを更新しました: ${id}`);
  });

jobCmd
  .command("run <id>")
  .description("ジョブを開始")
  .action((id: string) => {
    const { config, store } = getContext();
    const job = store.load(id);
    const wf = getWorkflow(config, job.frontmatter.workflow);
    const engine = new WorkflowEngine(wf, store);
    const startedJob = engine.startJob(id);
    const phase = startedJob.frontmatter.current_phase ?? "?";
    console.log(`ジョブを開始しました: ${id} (フェーズ: ${phase})`);
  });

jobCmd
  .command("transition <id> <result>")
  .description("フェーズ遷移")
  .option("--message <message>", "メッセージ", "")
  .action((id: string, result: string, options: { message: string }) => {
    const { config, store } = getContext();
    const condition = parseTransitionCondition(result);
    const job = store.load(id);
    const wf = getWorkflow(config, job.frontmatter.workflow);
    const engine = new WorkflowEngine(wf, store);
    const updatedJob = engine.transition(id, condition, options.message);
    printTransitionResult(updatedJob);
  });

jobCmd
  .command("approve <id>")
  .description("レビュー承認")
  .option("--message <message>", "メッセージ", "")
  .action((id: string, options: { message: string }) => {
    const { config, store } = getContext();
    const job = store.load(id);
    const wf = getWorkflow(config, job.frontmatter.workflow);
    const engine = new WorkflowEngine(wf, store);
    const updatedJob = engine.approve(id, options.message);
    printTransitionResult(updatedJob);
  });

jobCmd
  .command("reject <id>")
  .description("レビュー却下")
  .option("--message <message>", "メッセージ")
  .action((id: string, options: { message?: string }) => {
    const { config, store } = getContext();
    const job = store.load(id);
    const wf = getWorkflow(config, job.frontmatter.workflow);
    const engine = new WorkflowEngine(wf, store);
    const updatedJob = engine.reject(id, options.message ?? "");
    printTransitionResult(updatedJob);
  });

jobCmd
  .command("abort <id>")
  .description("ジョブを中断")
  .action((id: string) => {
    const { config, store } = getContext();
    const job = store.load(id);
    const wf = getWorkflow(config, job.frontmatter.workflow);
    const engine = new WorkflowEngine(wf, store);
    engine.abortJob(id);
    console.log(`ジョブを中断しました: ${id}`);
  });

jobCmd
  .command("close <id>")
  .description("ジョブをクローズ")
  .action((id: string) => {
    const { config, store, iterationStore } = getContext();
    const job = store.load(id);
    const wf = getWorkflow(config, job.frontmatter.workflow);
    const engine = new WorkflowEngine(wf, store);
    engine.closeJob(id);
    iterationStore.remove(id);
    console.log(`ジョブをクローズしました: ${id}`);
  });

jobCmd
  .command("activate <id>")
  .description("実行中ジョブをアクティブとして登録")
  .action((id: string) => {
    const { squadDir } = getContext();
    cmdActivate(squadDir, id);
  });

jobCmd
  .command("deactivate <id>")
  .description("アクティブジョブの登録を解除")
  .action((id: string) => {
    const { squadDir } = getContext();
    cmdDeactivate(squadDir, id);
  });

jobCmd
  .command("next-action <id>")
  .description("サブエージェント完了後の次アクション判定")
  .requiredOption("--result <result>", "遷移条件")
  .option("--message <message>", "メッセージ", "")
  .option("--reset-iteration", "イテレーションをリセット", false)
  .action((id: string, options: { result: string; message: string; resetIteration: boolean }) => {
    const { config, store, iterationStore } = getContext();

    if (options.resetIteration) {
      iterationStore.reset(id);
    }

    const job = store.load(id);
    const wf = getWorkflow(config, job.frontmatter.workflow);
    const phaseName = job.frontmatter.current_phase;
    if (!phaseName) {
      throw new CcsquadError("workflow", "現在のフェーズが設定されていません");
    }
    const phaseConfig = wf.getPhase(phaseName);
    if (!phaseConfig) {
      throw new CcsquadError("workflow", `フェーズ '${phaseName}' がワークフローに定義されていません`);
    }

    const condition = parseTransitionCondition(options.result);

    // reviewer フェーズのバリデーション
    if (phaseConfig.reviewer !== undefined) {
      if (condition !== "approved" && condition !== "rejected") {
        throw new CcsquadError("workflow", "レビューフェーズでは approved/rejected を使用してください");
      }
    } else if (condition === "approved" || condition === "rejected") {
      throw new CcsquadError("workflow", "通常フェーズでは completed/failed を使用してください");
    }

    const next = wf.resolveTransition(phaseName, condition);

    type NextActionOutput = {
      action: string;
      job_id: string;
      status?: string;
      phase?: string;
      phase_description?: string;
      agent?: string;
      reviewer?: string;
      reason?: string;
    };

    let output: NextActionOutput;

    if (next === "COMPLETE" || next === "ABORT") {
      const engine = new WorkflowEngine(wf, store);
      if (phaseConfig.reviewer !== undefined) {
        if (condition === "approved") {
          engine.approve(id, options.message);
        } else {
          engine.reject(id, options.message);
        }
      } else {
        engine.transition(id, condition, options.message);
      }
      const updatedJob = store.load(id);
      iterationStore.remove(id);
      output = {
        action: "done",
        job_id: id,
        status: updatedJob.frontmatter.status,
      };
    } else {
      const nextPhase = wf.getPhase(next);
      if (!nextPhase) {
        throw new CcsquadError("workflow", `遷移先フェーズ '${next}' がワークフローに定義されていません`);
      }

      if (nextPhase.pause) {
        const updatedJob = store.load(id);
        appendPhaseLog(updatedJob, phaseName, condition, next, options.message);
        updatedJob.frontmatter.updated_at = new Date().toISOString();
        store.save(updatedJob);
        output = {
          action: "pause",
          job_id: id,
          phase: next,
          phase_description: nextPhase.description,
          agent: nextPhase.agent,
          reviewer: nextPhase.reviewer,
          reason: "pause",
        };
      } else {
        const currentIteration = iterationStore.get(id);
        if (currentIteration >= wf.maxIterations()) {
          const updatedJob = store.load(id);
          appendPhaseLog(updatedJob, phaseName, condition, next, options.message);
          updatedJob.frontmatter.updated_at = new Date().toISOString();
          store.save(updatedJob);
          output = {
            action: "pause",
            job_id: id,
            phase: next,
            phase_description: nextPhase.description,
            agent: nextPhase.agent,
            reviewer: nextPhase.reviewer,
            reason: "max_iterations",
          };
        } else {
          const engine = new WorkflowEngine(wf, store);
          if (phaseConfig.reviewer !== undefined) {
            if (condition === "approved") {
              engine.approve(id, options.message);
            } else {
              engine.reject(id, options.message);
            }
          } else {
            engine.transition(id, condition, options.message);
          }
          iterationStore.increment(id);
          output = {
            action: "continue",
            job_id: id,
            phase: next,
            phase_description: nextPhase.description,
            agent: nextPhase.agent,
            reviewer: nextPhase.reviewer,
          };
        }
      }
    }

    console.log(JSON.stringify(output, null, 2));
  });

// ===== memory commands =====
const memCmd = program.command("memory").description("メモリ管理");

memCmd
  .command("add <title> [body]")
  .description("エントリを追加")
  .option("--type <type>", "タイプ")
  .option("--file <file>", "ファイルから本文を読み込む")
  .action((title: string, body: string | undefined, options: { type?: string; file?: string }) => {
    const { entryStore } = getContext();
    memoryCmdAdd(entryStore, title, options.type, body, options.file);
  });

memCmd
  .command("list")
  .description("エントリ一覧を表示")
  .option("--type <type>", "タイプでフィルタ")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((options: { type?: string; format: string }) => {
    const { entryStore } = getContext();
    memoryCmdList(entryStore, options.type, options.format === "json" ? "json" : "text");
  });

memCmd
  .command("show <key>")
  .description("エントリ詳細を表示")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((key: string, options: { format: string }) => {
    const { entryStore } = getContext();
    memoryCmdShow(entryStore, key, options.format === "json" ? "json" : "text");
  });

memCmd
  .command("edit <key> [body]")
  .description("エントリを編集")
  .option("--title <title>", "新タイトル")
  .option("--type <type>", "新タイプ")
  .option("--no-type", "タイプを削除")
  .option("--file <file>", "ファイルから本文を読み込む")
  .action((key: string, body: string | undefined, options: { title?: string; type?: string; noType?: boolean; file?: string }) => {
    const { entryStore } = getContext();
    memoryCmdEdit(entryStore, key, options.title, options.type, options.noType, body, options.file);
  });

memCmd
  .command("delete <key>")
  .description("エントリを削除")
  .action((key: string) => {
    const { entryStore } = getContext();
    memoryCmdDelete(entryStore, key);
  });

memCmd
  .command("search <query>")
  .description("エントリを検索")
  .option("--type <type>", "タイプでフィルタ")
  .option("--format <format>", "出力形式 (text|json)", "text")
  .action((query: string, options: { type?: string; format: string }) => {
    const { entryStore } = getContext();
    memoryCmdSearch(entryStore, query, options.type, options.format === "json" ? "json" : "text");
  });

// ===== hook commands =====
const hookCmd = program.command("hook").description("フック処理");

hookCmd
  .command("on-agent-complete")
  .description("SubagentStop hook: サブエージェント完了時の処理")
  .action(() => {
    const configPath = findConfig();
    const config = SquadConfigImpl.load(configPath);
    const projectRoot = dirname(configPath);
    const squadDir = join(projectRoot, ".ccsquad");
    const jobsDir = join(squadDir, "jobs");
    cmdOnAgentComplete(config, jobsDir, squadDir);
  });

// ===== setup command =====
program
  .command("setup")
  .description("プロジェクトに ccsquad をセットアップ")
  .option("--force", "既存ファイルを上書き", false)
  .option("--skip-skills", "スキルのインストールをスキップ", false)
  .option("--skip-hooks", "フックの設定をスキップ", false)
  .option("--skip-agents", "エージェント定義のコピーをスキップ", false)
  .option("--skip-config", "ccsquad.yaml の作成をスキップ", false)
  .action(
    (options: {
      force: boolean;
      skipSkills: boolean;
      skipHooks: boolean;
      skipAgents: boolean;
      skipConfig: boolean;
    }) => {
      cmdSetup({
        force: options.force,
        skipSkills: options.skipSkills,
        skipHooks: options.skipHooks,
        skipAgents: options.skipAgents,
        skipConfig: options.skipConfig,
      });
    },
  );

// ===== entry point =====
try {
  program.parse();
} catch (e) {
  if (e instanceof CcsquadError) {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
