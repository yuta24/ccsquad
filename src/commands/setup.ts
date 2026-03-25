import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  SKILL_JOB,
  SKILL_MEMORY,
  AGENT_CODER,
  AGENT_REVIEWER,
  DEFAULT_CONFIG,
} from "../embedded.js";

export interface SetupArgs {
  force: boolean;
  skipSkills: boolean;
  skipAgents: boolean;
  skipConfig: boolean;
}

export function cmdSetup(args: SetupArgs): void {
  console.log("ccsquad setup を実行中...");

  const projectRoot = process.cwd();

  if (!args.skipConfig) {
    setupConfig(projectRoot, args.force);
  }

  if (!args.skipSkills) {
    setupSkills(projectRoot, args.force);
  }

  if (!args.skipAgents) {
    setupAgents(projectRoot, args.force);
  }

  console.log("セットアップが完了しました。");
}

function setupConfig(projectRoot: string, force: boolean): void {
  const configPath = join(projectRoot, "ccsquad.yaml");

  if (existsSync(configPath) && !force) {
    console.log("  設定ファイル: ccsquad.yaml (既に存在、スキップ)");
    return;
  }

  writeFileSync(configPath, DEFAULT_CONFIG, "utf-8");
  console.log("  設定ファイル: ccsquad.yaml を作成しました");
}

function setupSkills(projectRoot: string, force: boolean): void {
  const skills: Array<[string, string]> = [
    ["job", SKILL_JOB],
    ["memory", SKILL_MEMORY],
  ];

  for (const [name, content] of skills) {
    const skillDir = join(projectRoot, ".claude", "skills", name);
    const skillPath = join(skillDir, "SKILL.md");

    if (existsSync(skillPath) && !force) {
      console.log(`  スキル: ${name} (既に存在、スキップ)`);
      continue;
    }

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, content, "utf-8");
    console.log(`  スキル: ${name} を作成しました`);
  }
}

function setupAgents(projectRoot: string, force: boolean): void {
  const agents: Array<[string, string]> = [
    ["coder", AGENT_CODER],
    ["reviewer", AGENT_REVIEWER],
  ];

  const agentsDir = join(projectRoot, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });

  for (const [name, content] of agents) {
    const agentPath = join(agentsDir, `${name}.md`);

    if (existsSync(agentPath) && !force) {
      console.log(`  エージェント: ${name} (既に存在、スキップ)`);
      continue;
    }

    writeFileSync(agentPath, content, "utf-8");
    console.log(`  エージェント: ${name} を作成しました`);
  }
}

