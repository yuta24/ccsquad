import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState, useCallback, useMemo, useEffect } from "react";
import type { MutableRefObject } from "react";
import type { SquadConfig, WorkflowConfig } from "../../config.js";
import type { Job } from "../../job.js";
import { JobStore } from "../../job.js";
import type { IterationStore } from "../../iteration.js";
import { resolveAndExecuteTransition } from "../../service/transition.js";
import type { SignalMessage } from "../../service/signal-server.js";
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
  signalHandlerRef: MutableRefObject<((msg: SignalMessage) => void) | null>;
  onRunAgent: (jobId: string, phase: string) => void;
  onDone: () => void;
  onQuit: () => void;
}

export function PauseReviewView({
  jobId, phase, info, store, config, iterationStore, signalHandlerRef,
  onRunAgent, onDone, onQuit,
}: PauseReviewViewProps) {
  const [statusMsg, setStatusMsg] = useState<string>("");

  // Signal handler: auto-run agent on notification signal
  useEffect(() => {
    signalHandlerRef.current = (msg: SignalMessage) => {
      if (msg.job_id && msg.job_id !== jobId) return;
      if (msg.event === "notification") {
        // Signal indicates agent should proceed
        onRunAgent(jobId, info.nextPhase);
      }
    };
    return () => {
      signalHandlerRef.current = null;
    };
  }, [jobId, signalHandlerRef, onRunAgent, info.nextPhase]);

  const handleTransitionResult = useCallback((condition: "approved" | "rejected" | "completed" | "failed") => {
    try {
      const jobData = store.load(jobId);
      const wf = config.getWorkflow(jobData.frontmatter.workflow);
      if (!wf) { setStatusMsg("ワークフローが見つかりません"); return; }

      const txResult = resolveAndExecuteTransition(wf, store, iterationStore, jobId, condition, "");

      switch (txResult.type) {
        case "done":
          onDone();
          break;
        case "continue":
          onRunAgent(jobId, txResult.nextPhase);
          break;
        case "pause":
          if (txResult.reason === "human_review") {
            setStatusMsg(`次フェーズ '${txResult.nextPhase}' はレビュー待ちです`);
          } else {
            onRunAgent(jobId, txResult.nextPhase);
          }
          break;
      }
    } catch (e) {
      setStatusMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [jobId, store, config, iterationStore, onRunAgent, onDone]);

  const executeApprove = useCallback(() => {
    try {
      const jobData = store.load(jobId);
      const wf = config.getWorkflow(jobData.frontmatter.workflow);
      if (!wf) { setStatusMsg("ワークフローが見つかりません"); return; }
      const currentPhase = jobData.frontmatter.current_phase ?? phase;
      const phaseConfig = wf.getPhase(currentPhase);
      const condition = phaseConfig?.type === "review" ? "approved" : "completed";
      handleTransitionResult(condition);
    } catch (e) {
      setStatusMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [jobId, store, config, phase, handleTransitionResult]);

  const executeReject = useCallback(() => {
    try {
      const jobData = store.load(jobId);
      const wf = config.getWorkflow(jobData.frontmatter.workflow);
      if (!wf) { setStatusMsg("ワークフローが見つかりません"); return; }
      const currentPhase = jobData.frontmatter.current_phase ?? phase;
      const phaseConfig = wf.getPhase(currentPhase);
      const condition = phaseConfig?.type === "review" ? "rejected" : "failed";
      handleTransitionResult(condition);
    } catch (e) {
      setStatusMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [jobId, store, config, phase, handleTransitionResult]);

  useKeyboard((event: KeyEvent) => {
    if (event.ctrl && event.name === "q") { onQuit(); event.preventDefault(); return; }
    if (event.name === "escape") { onDone(); event.preventDefault(); return; }

    const isHumanReview = info.phaseType === "review" && info.reviewer === "human";
    const isAgentReview = info.phaseType === "review" && info.reviewer !== "human";

    if (isHumanReview) {
      if (event.name === "a") { executeApprove(); event.preventDefault(); return; }
      if (event.name === "x") { executeReject(); event.preventDefault(); return; }
    } else if (isAgentReview) {
      if (event.name === "r" || event.name === "return" || event.name === "enter") {
        onRunAgent(jobId, info.nextPhase);
        event.preventDefault();
        return;
      }
      if (event.name === "a") { executeApprove(); event.preventDefault(); return; }
      if (event.name === "x") { executeReject(); event.preventDefault(); return; }
    } else {
      // max_iterations pause for task phase
      if (event.name === "return" || event.name === "enter") {
        onRunAgent(jobId, info.nextPhase);
        event.preventDefault();
        return;
      }
    }

    event.preventDefault();
  });

  const { job, wfConfig, iteration } = useMemo(() => {
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
    return { job, wfConfig, iteration };
  }, [jobId, store, config, iterationStore, statusMsg]);

  const isHumanReview = info.phaseType === "review" && info.reviewer === "human";
  const isAgentReview = info.phaseType === "review" && info.reviewer !== "human";

  let keybinds: StatusBarItem[];
  if (isHumanReview) {
    keybinds = [
      { key: "a", label: "承認" }, { key: "x", label: "却下" },
      { key: "Esc", label: "一覧へ戻る" }, { key: "Ctrl+Q", label: "終了" },
    ];
  } else if (isAgentReview) {
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

  const reasonLabel = info.reason === "max_iterations" ? "イテレーション上限到達" : "レビュー待ち";
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
