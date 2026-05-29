import type { Job, PhaseConfig } from "../domain/types.js";
import { getPhase } from "../domain/workflow.js";

export function buildJobPrompt(job: Job): string {
  const { id, title, current_phase, iteration, max_iterations, acceptance_criteria, workflow } = job.frontmatter;

  const acList = acceptance_criteria.length > 0
    ? acceptance_criteria.map((ac) => `- [${ac.done ? "x" : " "}] ${ac.description}`).join("\n")
    : "（未定義）";

  const phaseConfig = current_phase ? getPhase(workflow, current_phase) : undefined;

  return [
    `以下のジョブを実行してください。`,
    ``,
    `## ジョブ情報`,
    `- ID: ${id}`,
    `- タイトル: ${title}`,
    `- 現在のフェーズ: ${current_phase ?? "（未開始）"}`,
    `- イテレーション: ${iteration}/${max_iterations}`,
    ``,
    `## Acceptance Criteria`,
    acList,
    ``,
    `## ジョブ内容`,
    job.body.trim() || "（内容なし）",
    ``,
    `## 実行手順`,
    `1. cat .ccsquad/logs/${id}.md でフェーズログを確認（前回の記録があれば必ず読む）`,
    `2. ccsquad job show ${id} --format json で最新状態と suggested_commands を確認`,
    `3. 下記「フェーズ別作業指示」に従って作業を実施`,
    `4. 作業完了後: ccsquad job log ${id} "作業内容・判断・成果物のサマリー"`,
    `5. 遷移後の type を確認:`,
    `   - "continue" → 1 に戻る（次のフェーズを実行）`,
    `   - "pause" reason=human_review → ユーザーに報告して停止`,
    `   - "pause" reason=max_iterations → 上限到達を報告して停止`,
    `   - "done" → 完了/失敗を報告して終了`,
    ``,
    ...buildPhaseInstructions(id, phaseConfig),
  ].join("\n");
}

function buildPhaseInstructions(jobId: string, phaseConfig: PhaseConfig | undefined): string[] {
  if (!phaseConfig) {
    return [
      `## フェーズ別作業指示`,
      `フェーズ情報が取得できませんでした。ccsquad job show ${jobId} --format json で確認してください。`,
    ];
  }

  const lines: string[] = [`## フェーズ別作業指示 (${phaseConfig.type})`];

  switch (phaseConfig.type) {
    case "plan":
      lines.push(
        `要件・技術的課題を調査・分析し、実装計画を立てます。`,
        `- 調査・分析を行い、実装方針を決定する`,
        `- ccsquad job update ${jobId} --ac '[{"description":"基準1"},{"description":"基準2"}]' で Acceptance Criteria を具体化する`,
        ``,
        `遷移コマンド:`,
        `  ccsquad job transition ${jobId} completed --message "計画内容の要約"`,
        `  ccsquad job transition ${jobId} failed    --message "失敗理由"`,
      );
      break;

    case "execute":
      lines.push(
        `Acceptance Criteria を全て満たすよう実装・テストを行います。`,
        `- 各 Acceptance Criteria を確認しながら実装する`,
        `- テストを実行して動作を確認する`,
        ``,
        `遷移コマンド:`,
        `  ccsquad job transition ${jobId} completed --message "実装内容の要約"`,
        `  ccsquad job transition ${jobId} failed    --message "失敗理由"`,
      );
      break;

    case "review":
      if (phaseConfig.auto) {
        lines.push(
          `Acceptance Criteria を検証します（自動レビュー）。`,
          `- 各 AC を検証し、必ず以下のフォーマットで評価を出力する:`,
          `    - [x] 基準の説明: 達成していると判断した理由`,
          `    - [ ] 基準の説明: 未達の具体的な理由（何が足りないか）`,
          ``,
          `遷移コマンド:`,
          `  ccsquad job transition ${jobId} approved --message "承認理由"`,
          `  ccsquad job transition ${jobId} rejected --message "却下理由（未達 AC と改善指示を明記）"`,
        );
      } else {
        lines.push(
          `このフェーズは人間のレビューが必要です。作業を停止してユーザーに報告してください。`,
          ``,
          `ユーザーが確認後に以下を実行します:`,
          `  ccsquad job transition ${jobId} approved --message "承認理由"`,
          `  ccsquad job transition ${jobId} rejected --message "却下理由（未達 AC と改善指示を明記）"`,
        );
      }
      break;
  }

  return lines;
}
