import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  SKILL_JOB,
  SKILL_MEMORY,
  DEFAULT_CONFIG,
} from "../../embedded.js";

export interface SetupArgs {
  force: boolean;
  skipSkills: boolean;
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

  setupHooks(projectRoot);

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

function setupHooks(projectRoot: string): void {
  const settingsDir = join(projectRoot, ".claude");
  mkdirSync(settingsDir, { recursive: true });

  const settingsPath = join(settingsDir, "settings.local.json");

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      // invalid JSON は上書き
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const hookDefs: Array<{ event: string; command: string }> = [
    { event: "Stop", command: "[ -n \"$JOB_ID\" ] && ccsquad signal stop --job $JOB_ID || true" },
    { event: "Notification", command: "[ -n \"$JOB_ID\" ] && ccsquad signal notification --job $JOB_ID || true" },
  ];

  let changed = false;
  for (const { event, command } of hookDefs) {
    const existing = hooks[event];
    const alreadyExists = Array.isArray(existing) && existing.some((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false;
      const e = entry as Record<string, unknown>;
      if (!Array.isArray(e.hooks)) return false;
      return e.hooks.some((h: unknown) => {
        if (typeof h !== "object" || h === null) return false;
        return (h as Record<string, unknown>).command === command;
      });
    });

    if (alreadyExists) {
      console.log(`  Hooks: ${event} (既に設定済み、スキップ)`);
      continue;
    }

    const arr = Array.isArray(existing) ? existing : [];
    arr.push({ hooks: [{ type: "command", command }] });
    hooks[event] = arr;
    changed = true;
    console.log(`  Hooks: ${event} hook を追加しました`);
  }

  if (changed) {
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }
}
