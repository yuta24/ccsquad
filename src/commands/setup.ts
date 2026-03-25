import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  SKILL_JOB,
  SKILL_JOB_RUN,
  SKILL_JOB_APPROVE,
  SKILL_JOB_REJECT,
  SKILL_MEMORY,
  AGENT_CODER,
  AGENT_REVIEWER,
  DEFAULT_CONFIG,
} from "../embedded.js";

export interface SetupArgs {
  force: boolean;
  skipSkills: boolean;
  skipHooks: boolean;
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

  if (!args.skipHooks) {
    setupHooks(projectRoot);
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
    ["job-run", SKILL_JOB_RUN],
    ["job-approve", SKILL_JOB_APPROVE],
    ["job-reject", SKILL_JOB_REJECT],
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

function setupHooks(projectRoot: string): void {
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");

  let json: Record<string, unknown>;
  if (existsSync(settingsPath)) {
    const content = readFileSync(settingsPath, "utf-8");
    try {
      const parsed = JSON.parse(content) as unknown;
      json =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      json = {};
    }
  } else {
    json = {};
  }

  // hooks.SubagentStop 配列内に既存のエントリがあるか確認
  const hookCommand = "ccsquad hook on-agent-complete";
  const hooks = json["hooks"];
  let alreadySet = false;

  if (hooks !== null && typeof hooks === "object" && !Array.isArray(hooks)) {
    const hooksObj = hooks as Record<string, unknown>;
    const subagentStop = hooksObj["SubagentStop"];
    if (Array.isArray(subagentStop)) {
      alreadySet = subagentStop.some((entry: unknown) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
        const entryObj = entry as Record<string, unknown>;
        const entryHooks = entryObj["hooks"];
        if (!Array.isArray(entryHooks)) return false;
        return entryHooks.some((h: unknown) => {
          if (h === null || typeof h !== "object" || Array.isArray(h)) return false;
          const hObj = h as Record<string, unknown>;
          return typeof hObj["command"] === "string" && (hObj["command"] as string).includes(hookCommand);
        });
      });
    }
  }

  if (alreadySet) {
    console.log("  フック: SubagentStop フック (既に存在、スキップ)");
    return;
  }

  const hookEntry = {
    matcher: "coder|reviewer",
    hooks: [
      {
        type: "command",
        command: hookCommand,
        timeout: 30000,
      },
    ],
  };

  // Ensure hooks object exists
  if (json["hooks"] === undefined || json["hooks"] === null || typeof json["hooks"] !== "object" || Array.isArray(json["hooks"])) {
    json["hooks"] = {};
  }
  const hooksObj = json["hooks"] as Record<string, unknown>;

  // Ensure SubagentStop array exists
  if (!Array.isArray(hooksObj["SubagentStop"])) {
    hooksObj["SubagentStop"] = [];
  }
  (hooksObj["SubagentStop"] as unknown[]).push(hookEntry);

  const claudeDir = join(projectRoot, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const output = JSON.stringify(json, null, 2) + "\n";
  writeFileSync(settingsPath, output, "utf-8");
  console.log("  フック: SubagentStop フックを追加しました");
}
