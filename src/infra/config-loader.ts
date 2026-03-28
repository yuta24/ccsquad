import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse } from "yaml";
import { CcsquadError } from "../error.js";
import type { WorkflowConfig, PhaseConfig, PhaseType, TransitionCondition } from "../domain/types.js";

export function findConfigPath(): string | null {
  const root = process.env.CCSQUAD_ROOT;
  if (root) {
    const candidate = join(root, "ccsquad.yaml");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, "ccsquad.yaml");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export function findConfigPathOrThrow(): string {
  const path = findConfigPath();
  if (!path) {
    throw new CcsquadError("config", "ccsquad.yaml が見つかりません");
  }
  return path;
}

export function loadConfig(path: string): Record<string, WorkflowConfig> {
  const content = readFileSync(path, "utf-8");
  return parseConfig(content);
}

export function parseConfig(content: string): Record<string, WorkflowConfig> {
  const raw = parse(content);
  if (!raw || typeof raw !== "object" || !raw.workflows) {
    throw new CcsquadError("config", "設定ファイルの形式が不正です");
  }

  const workflows: Record<string, WorkflowConfig> = {};
  for (const [name, wfRaw] of Object.entries(raw.workflows as Record<string, unknown>)) {
    const wf = wfRaw as Record<string, unknown>;
    const phasesRaw = wf.phases;

    let phases: PhaseConfig[];
    if (Array.isArray(phasesRaw)) {
      phases = phasesRaw.map((p: Record<string, unknown>) => ({
        name: p.name as string,
        type: p.type as PhaseType,
        description: p.description as string | undefined,
        agent: p.agent as string | undefined,
        reviewer: p.reviewer as string | undefined,
        prompt: p.prompt as string | undefined,
        output_format: p.output_format === null ? null : (p.output_format as string[] | undefined),
        on: (p.on as Partial<Record<TransitionCondition, string>>) ?? {},
      }));
    } else {
      phases = [];
    }

    workflows[name] = {
      description: wf.description as string | undefined,
      max_iterations: wf.max_iterations as number | undefined,
      phases,
    };
  }

  return workflows;
}
