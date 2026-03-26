import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState, useCallback, useMemo, useEffect } from "react";
import type { MutableRefObject } from "react";
import type { SquadConfig, WorkflowConfig } from "../../config.js";
import type { Job } from "../../job.js";
import { JobStore } from "../../job.js";
import type { IterationStore } from "../../iteration.js";
import { OutputStore } from "../../output.js";
import { truncateOutput } from "../../service/prompt-builder.js";
import { resolveAndExecuteTransition } from "../../service/transition.js";
import type { SignalMessage } from "../../service/signal-server.js";
import { PhaseHeader } from "../components/phase-header.js";
import { StatusBar } from "../components/status-bar.js";
import { ScrollableText } from "../components/scrollable-text.js";
import { useSyncedState } from "../hooks/use-synced-state.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import type { TransitionInfo, StatusBarItem } from "../constants.js";
import {
  ATTR_BOLD, COLOR_WHITE, COLOR_GRAY, COLOR_CYAN, COLOR_YELLOW,
  COLOR_GREEN, COLOR_RED, truncateStr,
} from "../constants.js";

type ReviewMode = "browse" | "decide" | "feedback";

interface PauseReviewViewProps {
  jobId: string;
  phase: string;
  info: TransitionInfo;
  store: JobStore;
  config: SquadConfig;
  iterationStore: IterationStore;
  outputStore: OutputStore;
  signalHandlerRef: MutableRefObject<((msg: SignalMessage) => void) | null>;
  onRunAgent: (jobId: string, phase: string) => void;
  onDone: () => void;

}

export function PauseReviewView({
  jobId, phase, info, store, config, iterationStore, outputStore, signalHandlerRef,
  onRunAgent, onDone,
}: PauseReviewViewProps) {
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [mode, setMode, modeRef] = useSyncedState<ReviewMode>("browse");
  const [scrollOffset, setScrollOffset, scrollOffsetRef] = useSyncedState(0);
  const [feedbackText, setFeedbackText, feedbackTextRef] = useSyncedState("");
  const { rows } = useTerminalSize();

  // Signal handler: auto-run agent on notification signal
  useEffect(() => {
    signalHandlerRef.current = (msg: SignalMessage) => {
      if (msg.job_id && msg.job_id !== jobId) return;
      if (msg.event === "notification") {
        onRunAgent(jobId, info.nextPhase);
      }
    };
    return () => {
      signalHandlerRef.current = null;
    };
  }, [jobId, signalHandlerRef, onRunAgent, info.nextPhase]);

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

  const lastOutput = useMemo(() => {
    try {
      return outputStore.findLastByPhase(jobId, info.prevPhase);
    } catch {
      return undefined;
    }
  }, [outputStore, jobId, info.prevPhase]);

  const contentLines = useMemo(() => {
    const lines: string[] = [];
    lines.push("--- ジョブ本文 ---");
    if (job?.body) {
      lines.push(...job.body.split("\n"));
    } else {
      lines.push("(なし)");
    }
    lines.push("");
    lines.push(`--- Claude 出力 (phase: ${info.prevPhase}) ---`);
    if (lastOutput) {
      const content = truncateOutput(lastOutput.content);
      lines.push(...content.split("\n"));
    } else {
      lines.push("[このフェーズの出力は記録されていません]");
    }
    return lines;
  }, [job, lastOutput, info.prevPhase]);

  const handleTransitionResult = useCallback((condition: "approved" | "rejected" | "completed" | "failed", message?: string) => {
    try {
      const jobData = store.load(jobId);
      const wf = config.getWorkflow(jobData.frontmatter.workflow);
      if (!wf) { setStatusMsg("ワークフローが見つかりません"); return; }

      const txResult = resolveAndExecuteTransition(wf, store, iterationStore, jobId, condition, message ?? "");

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

  const executeRejectWithFeedback = useCallback((feedback: string) => {
    try {
      const jobData = store.load(jobId);
      const wf = config.getWorkflow(jobData.frontmatter.workflow);
      if (!wf) { setStatusMsg("ワークフローが見つかりません"); return; }
      const currentPhase = jobData.frontmatter.current_phase ?? phase;
      const phaseConfig = wf.getPhase(currentPhase);
      const condition = phaseConfig?.type === "review" ? "rejected" : "failed";

      if (feedback.trim()) {
        outputStore.save(jobId, {
          phase: currentPhase,
          executor: "human",
          result: "rejected",
          iteration: iterationStore.get(jobId),
          timestamp: new Date().toISOString(),
          content: feedback,
        });
      }

      handleTransitionResult(condition, feedback);
    } catch (e) {
      setStatusMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [jobId, store, config, iterationStore, outputStore, phase, handleTransitionResult]);

  const isHumanReview = info.phaseType === "review" && info.reviewer === "human";
  const isAgentReview = info.phaseType === "review" && info.reviewer !== "human";

  useKeyboard((event: KeyEvent) => {
    if (!isHumanReview) {
      // Non-human-review: original behavior
      if (event.name === "escape") { onDone(); event.preventDefault(); return; }

      if (isAgentReview) {
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
      return;
    }

    // Human review mode-based handling
    const currentMode = modeRef.current;

    if (currentMode === "browse") {
      if (event.name === "escape") { onDone(); event.preventDefault(); return; }
      if (event.name === "up" || event.name === "k") {
        setScrollOffset((prev) => Math.max(0, prev - 1));
        event.preventDefault();
        return;
      }
      if (event.name === "down" || event.name === "j") {
        setScrollOffset((prev) => Math.max(0, Math.min(Math.max(0, contentLines.length - viewportHeight), prev + 1)));
        event.preventDefault();
        return;
      }
      if (event.name === "return" || event.name === "enter") {
        setMode("decide");
        event.preventDefault();
        return;
      }
    } else if (currentMode === "decide") {
      if (event.name === "escape") { setMode("browse"); event.preventDefault(); return; }
      if (event.name === "a") { executeApprove(); event.preventDefault(); return; }
      if (event.name === "x") { setMode("feedback"); setFeedbackText(""); event.preventDefault(); return; }
    } else if (currentMode === "feedback") {
      if (event.name === "escape") { setMode("decide"); event.preventDefault(); return; }
      if (event.ctrl && (event.name === "return" || event.name === "enter")) {
        executeRejectWithFeedback(feedbackTextRef.current);
        event.preventDefault();
        return;
      }
      if (event.name === "backspace" || event.name === "delete") {
        setFeedbackText((prev) => [...prev].slice(0, -1).join(""));
        event.preventDefault();
        return;
      }
      if (event.name === "return" || event.name === "enter") {
        setFeedbackText((prev) => prev + "\n");
        event.preventDefault();
        return;
      }
      if (!event.ctrl && !event.meta && event.sequence && event.sequence.length === 1) {
        setFeedbackText((prev) => prev + event.sequence);
        event.preventDefault();
        return;
      }
    }

    event.preventDefault();
  });

  let keybinds: StatusBarItem[];
  if (isHumanReview) {
    if (mode === "browse") {
      keybinds = [
        { key: "↑/↓", label: "スクロール" },
        { key: "Enter", label: "判断へ" },
        { key: "Esc", label: "一覧に戻る" },
      ];
    } else if (mode === "decide") {
      keybinds = [
        { key: "a", label: "承認" },
        { key: "x", label: "却下" },
        { key: "Esc", label: "閲覧に戻る" },
      ];
    } else {
      keybinds = [
        { key: "Ctrl+Enter", label: "却下を確定" },
        { key: "Esc", label: "判断に戻る" },
      ];
    }
  } else if (isAgentReview) {
    keybinds = [
      { key: "r/Enter", label: "レビューエージェント実行" },
      { key: "a", label: "直接承認" }, { key: "x", label: "直接却下" },
      { key: "Esc", label: "一覧へ戻る" },
    ];
  } else {
    keybinds = [
      { key: "Enter", label: "エージェント実行" },
      { key: "Esc", label: "一覧へ戻る" },
    ];
  }

  const reasonLabel = info.reason === "max_iterations" ? "イテレーション上限到達" : "レビュー待ち";
  const resultColor = info.result === "completed" || info.result === "approved" ? COLOR_GREEN : COLOR_RED;
  const reviewerColor = info.reviewer === "human" ? COLOR_CYAN : COLOR_GREEN;

  // Reserve rows for header (~4) and status bar (~1)
  const HEADER_ROWS = 4;
  const STATUS_BAR_ROWS = 1;
  const viewportHeight = Math.max(4, rows - HEADER_ROWS - STATUS_BAR_ROWS - 4);

  return (
    <box width="100%" height="100%" flexDirection="column">
      {job && <PhaseHeader job={job} workflowConfig={wfConfig} iteration={iteration} />}

      {isHumanReview ? (
        <>
          {mode === "browse" && (
            <ScrollableText
              lines={contentLines}
              height={viewportHeight}
              offset={scrollOffset}
            />
          )}
          {mode === "decide" && (
            <box flexGrow={1} flexDirection="column" borderStyle="single" borderColor={COLOR_YELLOW} padding={1}>
              <text fg={COLOR_YELLOW} attributes={ATTR_BOLD}>一時停止: レビュー待ち</text>
              <box height={1} />
              <text fg={COLOR_GRAY}>前フェーズ: <text fg={COLOR_WHITE}>{info.prevPhase}</text> → <text fg={resultColor}>{info.result}</text></text>
              <text fg={COLOR_GRAY}>次フェーズ: <text fg={COLOR_YELLOW}>{info.nextPhase}</text> (レビュアー: <text fg={COLOR_CYAN}>human</text>)</text>
              <box height={1} />
              <text fg={COLOR_WHITE}>  [a] 承認  [x] 却下</text>
              {statusMsg ? <><box height={1} /><text fg={COLOR_RED}>{statusMsg}</text></> : null}
            </box>
          )}
          {mode === "feedback" && (
            <box flexGrow={1} flexDirection="column" borderStyle="single" borderColor={COLOR_CYAN} padding={1}>
              <text fg={COLOR_CYAN} attributes={ATTR_BOLD}>却下理由を入力してください</text>
              <box height={1} />
              <box flexGrow={1} borderStyle="single" borderColor={COLOR_GRAY} paddingLeft={1}>
                <text fg={COLOR_WHITE}>{feedbackText}█</text>
              </box>
              {statusMsg ? <><box height={1} /><text fg={COLOR_RED}>{statusMsg}</text></> : null}
            </box>
          )}
        </>
      ) : (
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
      )}

      <StatusBar items={keybinds} />
    </box>
  );
}
