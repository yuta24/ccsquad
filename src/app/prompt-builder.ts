export function buildJobPrompt(jobId: string): string {
  return [
    `以下のジョブを実行してください。`,
    ``,
    `ジョブID: ${jobId}`,
    ``,
    `手順:`,
    `1. ccsquad job show ${jobId} --format json でジョブの最新状態を確認`,
    `2. phase_config.type を確認。review の場合は停止して報告`,
    `3. phase_config.agent に対応するエージェント (.claude/agents/{agent}.md) として作業を実行`,
    `4. 完了後 ccsquad job transition ${jobId} completed --message "要約"`,
    `5. 失敗時 ccsquad job transition ${jobId} failed --message "理由"`,
    `6. 遷移結果を確認し、次のフェーズがあれば 1 に戻る`,
    `7. review フェーズに到達したら停止して報告`,
  ].join("\n");
}
