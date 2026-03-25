import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState, useCallback } from "react";
import type { SquadConfig, WorkflowConfig } from "../../config.js";
import type { Job } from "../../job.js";
import { JobStore } from "../../job.js";
import { WorkflowEngine } from "../../engine.js";
import type { IterationStore } from "../../iteration.js";
import { PhaseHeader } from "../components/phase-header.js";
import { StatusBar } from "../components/status-bar.js";
import type { TransitionInfo, StatusBarItem } from "../constants.js";
import {
  ATTR_BOLD, COLOR_WHITE, COLOR_GRAY, COLOR_CYAN, COLOR_YELLOW,
  COLOR_GREEN, COLOR_RED, truncateStr,
} from "../constants.js";

interface PauseReviewViewProps {
  jobId: string;
  phase: string;
  info: TransitionInfo;
  store: JobStore;
  config: SquadConfig;
  iterationStore: IterationStore;
  onRunAgent: (jobId: string, phase: string) => void;
  onDone: () => void;
  onQuit: () => void;
}

export function PauseReviewView({
  jobId, phase, info, store, config, iterationStore,
  onRunAgent, onDone, onQuit,
}: PauseReviewViewProps) {
  const [statusMsg, setStatusMsg] = useState<string>("");

  const executeApprove = useCallback(() => {
    try {
      const jobData = store.load(jobId);
      const wf = config.getWorkflow(jobData.frontmatter.workflow);
      if (!wf) { setStatusMsg("ワークフローが見つかりません"); return; }

      const currentPhase = jobData.frontmatter.current_phase ?? phase;
      const phaseConfig = wf.getPhase(currentPhase);
      if (!phaseConfig) { setStatusMsg(`フェーズ '${currentPhase}' が見つかりません`); return; }

      const engine = new WorkflowEngine(wf, store);
      if (phaseConfig.reviewer !== undefined) {
        engine.approve(jobId, "");
      } else {
        engine.transition(jobId, "completed", "");
      }

      const updatedJob = store.load(jobId);
      if (updatedJob.frontmatter.status === "completed" || updatedJob.frontmatter.status === "failed") {
        iterationStore.remove(jobId);
        onDone();
        return;
      }

      const nextPhaseName = updatedJob.frontmatter.current_phase;
      if (nextPhaseName) {
        const nextPhaseConfig = wf.getPhase(nextPhaseName);
        if (nextPhaseConfig?.reviewer === "human") {
          setStatusMsg(`次フェーズ '${nextPhaseName}' はレビュー待ちです`);
        } else {
          iterationStore.increment(jobId);
          onRunAgent(jobId, nextPhaseName);
        }
      } else {
        onDone();
      }
    } catch (e) {
      setStatusMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [jobId, store, config, iterationStore, phase, onRunAgent, onDone]);

  const executeReject = useCallback(() => {
    try {
      const jobData = store.load(jobId);
      const wf = config.getWorkflow(jobData.frontmatter.workflow);
      if (!wf) { setStatusMsg("ワークフローが見つかりません"); return; }

      const currentPhase = jobData.frontmatter.current_phase ?? phase;
      const phaseConfig = wf.getPhase(currentPhase);
      if (!phaseConfig) { setStatusMsg(`フェーズ '${currentPhase}' が見つかりません`); return; }

      const engine = new WorkflowEngine(wf, store);
      if (phaseConfig.reviewer !== undefined) {
        engine.reject(jobId, "");
      } else {
        engine.transition(jobId, "failed", "");
      }

      const updatedJob = store.load(jobId);
      if (updatedJob.frontmatter.status === "completed" || updatedJob.frontmatter.status === "failed") {
        iterationStore.remove(jobId);
        onDone();
        return;
      }

      const nextPhaseName = updatedJob.frontmatter.current_phase;
      if (nextPhaseName) {
        const nextPhaseConfig = wf.getPhase(nextPhaseName);
        if (nextPhaseConfig?.reviewer !== "human") {
          onRunAgent(jobId, nextPhaseName);
        } else {
          setStatusMsg(`却下しました。次フェーズ: ${nextPhaseName}`);
          onDone();
        }
      } else {
        onDone();
      }
    } catch (e) {
      setStatusMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [jobId, store, config, iterationStore, phase, onRunAgent, onDone]);

  useKeyboard((event: KeyEvent) => {
    if (event.ctrl && event.name === "q") { onQuit(); event.preventDefault(); return; }
    if (event.name === "escape") { onDone(); event.preventDefault(); return; }

    const isHumanReviewer = info.reviewer === "human";
    const isAgentReviewer = info.reviewer && info.reviewer !== "human";
    const isPauseOnly = !info.reviewer;

    if (isHumanReviewer) {
      if (event.name === "a") { executeApprove(); event.preventDefault(); return; }
      if (event.name === "x") { executeReject(); event.preventDefault(); return; }
    } else if (isAgentReviewer) {
      if (event.name === "r" || event.name === "return" || event.name === "enter") {
        try {
          const jobData = store.load(jobId);
          const wf = config.getWorkflow(jobData.frontmatter.workflow);
          if (wf) {
            const currentPhase = jobData.frontmatter.current_phase ?? phase;
            const phaseConfig = wf.getPhase(currentPhase);
            if (phaseConfig && phaseConfig.reviewer === undefined) {
              const engine = new WorkflowEngine(wf, store);
              engine.transition(jobId, "completed", "");
            }
          }
        } catch {
          // ignore
        }
        onRunAgent(jobId, info.nextPhase);
        event.preventDefault();
        return;
      }
      if (event.name === "a") { executeApprove(); event.preventDefault(); return; }
      if (event.name === "x") { executeReject(); event.preventDefault(); return; }
    } else if (isPauseOnly) {
      if (event.name === "return" || event.name === "enter") {
        try {
          const jobData = store.load(jobId);
          const wf = config.getWorkflow(jobData.frontmatter.workflow);
          if (wf) {
            const currentPhase = jobData.frontmatter.current_phase ?? phase;
            const phaseConfig = wf.getPhase(currentPhase);
            if (phaseConfig && phaseConfig.reviewer === undefined) {
              const engine = new WorkflowEngine(wf, store);
              engine.transition(jobId, "completed", "");
            }
          }
        } catch {
          // phase log was already recorded
        }
        onRunAgent(jobId, info.nextPhase);
        event.preventDefault();
        return;
      }
    }

    event.preventDefault();
  });

  let job: Job | null = null;
  let wfConfig: WorkflowConfig | undefined;
  let iteration = 0;
  try {
    job = store.load(jobId);
    wfConfig = config.getWorkflow(job.frontmatter.workflow);
    iteration = iterationStore.get(jobId);
  } catch {
    // ignore
  }

  const isHumanReviewer = info.reviewer === "human";
  const isAgentReviewer = info.reviewer && info.reviewer !== "human";

  let keybinds: StatusBarItem[];
  if (isHumanReviewer) {
    keybinds = [
      { key: "a", label: "承認" }, { key: "x", label: "却下" },
      { key: "Esc", label: "一覧へ戻る" }, { key: "Ctrl+Q", label: "終了" },
    ];
  } else if (isAgentReviewer) {
    keybinds = [
      { key: "r/Enter", label: "レビューエージェント実行" },
      { key: "a", label: "直接承認" }, { key: "x", label: "直接却下" },
      { key: "Esc", label: "一覧へ戻る" }, { key: "Ctrl+Q", label: "終了" },
    ];
  } else {
    keybinds = [
      { key: "Enter", label: "エージェント実行" },
      { key: "Esc", label: "一覧へ戻る" }, { key: "Ctrl+Q", label: "終了" },
    ];
  }

  const reasonLabel = info.reason === "pause" ? "一時停止"
    : info.reason === "max_iterations" ? "イテレーション上限到達" : "レビュー待ち";
  const resultColor = info.result === "completed" || info.result === "approved" ? COLOR_GREEN : COLOR_RED;
  const reviewerColor = info.reviewer === "human" ? COLOR_CYAN : COLOR_GREEN;

  return (
    <box width="100%" height="100%" flexDirection="column">
      {job && <PhaseHeader job={job} workflowConfig={wfConfig} iteration={iteration} />}

      <box flexGrow={1} flexDirection="column" borderStyle="single" borderColor={COLOR_YELLOW} padding={1}>
        <text fg={COLOR_YELLOW} attributes={ATTR_BOLD}>一時停止: {reasonLabel}</text>
        <box height={1} />

        <box flexDirection="column" borderStyle="single" borderColor={COLOR_GRAY} padding={1}>
          <text fg={COLOR_CYAN} attributes={ATTR_BOLD}>前フェーズ結果</text>
          <box height={1} />
          <text fg={COLOR_GRAY}>フェーズ: <text fg={COLOR_WHITE}>{info.prevPhase}</text></text>
          <text fg={COLOR_GRAY}>結果: <text fg={resultColor}>{info.result}</text></text>
          {info.message ? (
            <text fg={COLOR_GRAY}>メッセージ: <text fg={COLOR_WHITE}>{truncateStr(info.message, 80)}</text></text>
          ) : null}
        </box>

        <box height={1} />

        <box flexDirection="column" borderStyle="single" borderColor={COLOR_GRAY} padding={1}>
          <text fg={COLOR_CYAN} attributes={ATTR_BOLD}>次フェーズ情報</text>
          <box height={1} />
          <text fg={COLOR_GRAY}>フェーズ: <text fg={COLOR_YELLOW}>{info.nextPhase}</text></text>
          {info.description ? <text fg={COLOR_GRAY}>説明: <text fg={COLOR_WHITE}>{info.description}</text></text> : null}
          {info.agent ? <text fg={COLOR_GRAY}>エージェント: <text fg={COLOR_GREEN}>{info.agent}</text></text> : null}
          {info.reviewer ? <text fg={COLOR_GRAY}>レビュアー: <text fg={reviewerColor}>{info.reviewer}</text></text> : null}
        </box>

        {statusMsg ? (
          <>
            <box height={1} />
            <text fg={COLOR_RED}>{statusMsg}</text>
          </>
        ) : null}
      </box>

      <StatusBar items={keybinds} />
    </box>
  );
}
