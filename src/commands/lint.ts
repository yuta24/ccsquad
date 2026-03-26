import { SquadConfigImpl, type Diagnostic } from "../config.js";
import { findConfig } from "../service/context.js";
import { CcsquadError } from "../error.js";

export function formatLintResult(
  config: { workflows: Record<string, { phases: { name: string; type: string }[] }> },
  diagnostics: Diagnostic[],
): { output: string; errorCount: number; warningCount: number } {
  const lines: string[] = [];

  // Group diagnostics by workflow and phase
  const byWorkflowAndPhase: Record<string, Record<string, Diagnostic[]>> = {};
  for (const d of diagnostics) {
    if (!byWorkflowAndPhase[d.workflow]) {
      byWorkflowAndPhase[d.workflow] = {};
    }
    const key = d.phase ?? "__workflow__";
    if (!byWorkflowAndPhase[d.workflow][key]) {
      byWorkflowAndPhase[d.workflow][key] = [];
    }
    byWorkflowAndPhase[d.workflow][key].push(d);
  }

  for (const [workflowName, workflow] of Object.entries(config.workflows)) {
    lines.push(`ワークフロー: ${workflowName}`);

    // Workflow-level diagnostics (no phase)
    const workflowDiags = byWorkflowAndPhase[workflowName]?.["__workflow__"] ?? [];
    if (workflowDiags.length > 0) {
      for (const d of workflowDiags) {
        lines.push(`  ✗ (ワークフロー)`);
        lines.push(`    ${d.severity}: ${d.message}`);
      }
    }

    for (const phase of workflow.phases) {
      const phaseDiags = byWorkflowAndPhase[workflowName]?.[phase.name] ?? [];
      if (phaseDiags.length === 0) {
        lines.push(`  ✓ ${phase.name} (${phase.type})`);
      } else {
        lines.push(`  ✗ ${phase.name} (${phase.type})`);
        for (const d of phaseDiags) {
          lines.push(`    ${d.severity}: ${d.message}`);
        }
      }
    }

    lines.push("");
  }

  const errorCount = diagnostics.filter(d => d.severity === "error").length;
  const warningCount = diagnostics.filter(d => d.severity === "warning").length;

  if (errorCount === 0 && warningCount === 0) {
    lines.push("✓ 問題は見つかりませんでした");
  } else {
    lines.push(`結果: ${errorCount} errors, ${warningCount} warnings`);
  }

  return { output: lines.join("\n"), errorCount, warningCount };
}

export function cmdLint(configPath?: string): void {
  const resolvedPath = configPath ?? findConfig();
  if (!resolvedPath) {
    console.error("エラー: ccsquad.yaml が見つかりません");
    process.exit(1);
  }

  console.log(`${resolvedPath} を検証中...\n`);

  let config;
  try {
    config = SquadConfigImpl.load(resolvedPath);
  } catch (e) {
    if (e instanceof CcsquadError) {
      console.error(`エラー: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const diagnostics = config.lint();
  const { output, errorCount } = formatLintResult(config, diagnostics);

  console.log(output);

  if (errorCount > 0) {
    process.exit(1);
  }
}
