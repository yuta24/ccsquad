import type { Job } from "../domain/types.js";

export function buildJobPrompt(job: Job): string {
  const { id, title, current_phase, iteration, max_iterations, acceptance_criteria } = job.frontmatter;

  const acList = acceptance_criteria.length > 0
    ? acceptance_criteria.map((ac) => `- [${ac.done ? "x" : " "}] ${ac.description}`).join("\n")
    : "（未定義）";

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
    `## 手順`,
    `1. cat .ccsquad/logs/${id}.log でフェーズログを確認（前回の記録がある場合）`,
    `2. ccsquad job show ${id} --format json でジョブの最新状態を確認`,
    `3. phase_config.type を確認。review の場合は停止して報告`,
    `4. phase_config.agent に対応するエージェント (.claude/agents/{agent}.md) として作業を実行`,
    `5. 完了後 ccsquad job transition ${id} completed --message "要約"`,
    `6. 失敗時 ccsquad job transition ${id} failed --message "理由"`,
    `7. 遷移結果を確認し、次のフェーズがあれば 1 に戻る`,
    `8. review フェーズに到達したら停止して報告`,
  ].join("\n");
}
