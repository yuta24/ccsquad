import type { Job, PhaseConfig } from "../domain/types.js";
import { getPhase } from "../domain/workflow.js";

// logContent: .ccsquad/logs/<id>.md の内容。null の場合はログなし
export function buildJobPrompt(job: Job, logContent: string | null): string {
  const { id, title, current_phase, iteration, max_iterations, acceptance_criteria, workflow } = job.frontmatter;

  const acList = acceptance_criteria.length > 0
    ? acceptance_criteria.map((ac) => `- [${ac.done ? "x" : " "}] ${ac.description}`).join("\n")
    : "（未定義）";

  const phaseConfig = current_phase ? getPhase(workflow, current_phase) : undefined;

  // STATIC: タスク本体・AC・body（変化しない部分、キャッシュが効く）
  const staticLines = [
    `<static>`,
    `## タスク`,
    title,
    ``,
    `## Acceptance Criteria`,
    acList,
    ``,
    `## タスク詳細`,
    job.body.trim() || "（内容なし）",
    `</static>`,
  ];

  // DYNAMIC: 現在フェーズ・前回ログ・作業指示（毎回変わる部分）
  const dynamicLines = [
    `<dynamic>`,
    `## 現在の状態`,
    `- ID: ${id}`,
    `- フェーズ: ${current_phase ?? "（未開始）"}`,
    `- エージェント: ${phaseConfig?.agent ?? "（未定義）"}`,
    `- イテレーション: ${iteration}/${max_iterations}`,
    ``,
    `## 自律実行プロトコル`,
    `- このプロンプトの作業が終わったら、必ず現在フェーズに対応する ccsquad done コマンドを実行する`,
    `- completed / approved は、必要な検証を実行し Acceptance Criteria を満たしたと判断できる場合だけ使う`,
    `- 検証不能、未達、作業継続不能の場合は failed / rejected を使い、--message に理由と次の引き継ぎを書く`,
    `- 人間レビューが必要な指示が出ている場合は ccsquad done を実行せず、ユーザーに判断を求める`,
  ];

  if (logContent) {
    dynamicLines.push(
      ``,
      `## 前回までの記録`,
      logContent.trim(),
    );
  }

  dynamicLines.push(
    ``,
    ...buildPhaseInstructions(id, phaseConfig),
    `</dynamic>`,
  );

  return [`以下のジョブを実行してください。`, ``, ...staticLines, ``, ...dynamicLines].join("\n");
}

function buildPhaseInstructions(jobId: string, phaseConfig: PhaseConfig | undefined): string[] {
  if (!phaseConfig) {
    return [
      `## 作業指示`,
      `フェーズ情報が取得できませんでした。`,
    ];
  }

  const lines: string[] = [`## 作業指示 (${phaseConfig.type})`];

  switch (phaseConfig.type) {
    case "plan":
      lines.push(
        `要件・技術的課題を調査・分析し、実装計画を立てます。`,
        `1. 調査・分析を行い、実装方針を決定する`,
        `2. ccsquad update ${jobId} --ac '[{"description":"基準1"},{"description":"基準2"}]' で Acceptance Criteria を定義する`,
        `3. 必要であれば後続ワークフローを設計する（任意）`,
        ``,
        `## ワークフローの変更（任意）`,
        `デフォルト（plan → execute → review）では不十分な場合、--workflow で後続フェーズを再定義できます。`,
        `変更すべき場合の例:`,
        `  - フロントエンド・バックエンドを並列実装したい（agents を複数定義）`,
        `  - 専門エージェントを使い分けたい（調査・実装・テストを別フェーズに分離）`,
        `  - レビューを自動化したい（auto: true を付与）`,
        ``,
        `変更する場合は、現在の plan フェーズの定義も含む完全なワークフロー YAML を --workflow に渡します:`,
        `  ccsquad done ${jobId} completed --workflow 'plan:\\n  type: plan\\n  agent: plan\\n  on:\\n    completed: execute\\n    failed: ABORT\\nexecute:\\n  ...' --message "計画内容の要約"`,
        ``,
        `変更不要な場合は --workflow を省略します:`,
        `  ccsquad done ${jobId} completed --message "計画内容の要約"`,
        ``,
        `遷移:`,
        `  ccsquad done ${jobId} completed [--workflow <YAML>] --message "計画内容の要約"`,
        `  ccsquad done ${jobId} failed                       --message "失敗理由"`,
      );
      break;

    case "execute":
      lines.push(
        `Acceptance Criteria を全て満たすよう実装・テストを行います。`,
        `1. 各 Acceptance Criteria を確認しながら実装する`,
        `2. テストを実行して動作を確認する`,
        ``,
        `遷移:`,
        `  ccsquad done ${jobId} completed --message "実装内容の要約"`,
        `  ccsquad done ${jobId} failed    --message "失敗理由"`,
      );
      break;

    case "review":
      if (phaseConfig.auto) {
        lines.push(
          `Acceptance Criteria を検証します（自動レビュー）。`,
          `各 AC を検証し、必ず以下のフォーマットで評価を出力する:`,
          `  - [x] 基準の説明: 達成していると判断した理由`,
          `  - [ ] 基準の説明: 未達の具体的な理由（何が足りないか）`,
          ``,
          `遷移:`,
          `  ccsquad done ${jobId} approved  --message "承認理由"`,
          `  ccsquad done ${jobId} rejected  --message "却下理由（未達 AC と改善指示を明記）"`,
        );
      } else {
        lines.push(
          `このフェーズは人間のレビューが必要です。作業を停止してユーザーに報告してください。`,
          ``,
          `ユーザーが確認後に以下を実行します:`,
          `  ccsquad done ${jobId} approved  --message "承認理由"`,
          `  ccsquad done ${jobId} rejected  --message "却下理由（未達 AC と改善指示を明記）"`,
        );
      }
      break;
  }

  return lines;
}
