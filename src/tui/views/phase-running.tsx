import type { KeyEvent } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { CliRenderEvents } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { MutableRefObject } from "react";

import type { Job, WorkflowConfig, PhaseConfig } from "../../domain/types.js";
import { getPhase } from "../../domain/workflow.js";
import { parseTransitionCondition } from "../../domain/workflow.js";
import type { ProjectContext } from "../../app/project-context.js";
import type { JobService, TransitionResult } from "../../app/job-service.js";
import type { OutputService } from "../../app/output-service.js";
import type { PhaseExecutor, PhaseExecution } from "../../app/phase-executor.js";
import type { SignalMessage } from "../../infra/signal-server.js";
import type { DisplayLine } from "../../infra/stream-parser.js";

import { OutputLine } from "../components/output-line.js";
import { StatusBar } from "../components/status-bar.js";
import { InlineReview } from "./inline-review.js";
import type { TransitionInfo, StatusBarItem } from "../constants.js";
import {
  ATTR_BOLD, COLOR_CYAN, COLOR_GREEN, COLOR_RED, COLOR_DARK_GRAY, COLOR_WHITE,
  COLOR_HEADER_BG, COLOR_GRAY, COLOR_YELLOW, truncateStr,
} from "../constants.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { useSyncedState } from "../hooks/use-synced-state.js";

type ExecutionState = "idle" | "running" | "paused";
type FocusPane = "left" | "right";

interface PhaseRunningViewProps {
  jobId: string;
  phase: string;
  ctx: ProjectContext;
  jobService: JobService;
  outputService: OutputService;
  phaseExecutor: PhaseExecutor;
  signalHandlerRef: MutableRefObject<((msg: SignalMessage) => void) | null>;
  onDone: () => void;
}

export function PhaseRunningView({
  jobId, phase, ctx, jobService, outputService, phaseExecutor,
  signalHandlerRef, onDone,
}: PhaseRunningViewProps) {
  const renderer = useRenderer();
  const [displayLines, setDisplayLines] = useState<DisplayLine[]>([]);
  const executionRef = useRef<PhaseExecution | null>(null);
  const currentPhaseRef = useRef(phase);
  const displayLinesRef = useRef<DisplayLine[]>([]);
  const scrollBoxRef = useRef<ScrollBoxRenderable | null>(null);
  const { cols } = useTerminalSize();

  const [execState, setExecState, execStateRef] = useSyncedState<ExecutionState>("idle");
  const [focusPane, setFocusPane, focusPaneRef] = useSyncedState<FocusPane>("left");
  const [pauseInfo, setPauseInfo, pauseInfoRef] = useSyncedState<TransitionInfo | null>(null);
  const [statusMsg, setStatusMsg] = useState("");

  // ── Start a phase ──

  const startPhase = useCallback((phaseName: string) => {
    executionRef.current?.kill();
    displayLinesRef.current = [];
    setDisplayLines([]);

    const exec = phaseExecutor.start(jobId, phaseName, cols);
    executionRef.current = exec;

    exec.onDisplayLines((lines) => {
      displayLinesRef.current = [...displayLinesRef.current, ...lines];
      setDisplayLines([...displayLinesRef.current]);
    });

    exec.onExit((result: TransitionResult) => {
      handleTransitionResult(result);
    });

    exec.onError((msg) => {
      setStatusMsg(`エラー: ${msg}`);
      setExecState("idle");
    });
  }, [jobId, phaseExecutor, cols]);

  // ── Handle transition results ──

  const handleTransitionResult = useCallback((txResult: TransitionResult) => {
    switch (txResult.type) {
      case "done":
        onDone();
        break;
      case "continue":
        currentPhaseRef.current = txResult.nextPhase;
        setPauseInfo(null);
        setExecState("running");
        setFocusPane("right");
        startPhase(txResult.nextPhase);
        break;
      case "pause": {
        const prevPhase = currentPhaseRef.current;
        const lastOut = outputService.findLastByPhase(jobId, prevPhase);
        setPauseInfo({
          prevPhase,
          result: "completed",
          message: "",
          nextPhase: txResult.nextPhase,
          description: txResult.phaseConfig.description,
          agent: txResult.phaseConfig.agent,
          reviewer: txResult.phaseConfig.reviewer,
          phaseType: txResult.phaseConfig.type,
          reason: txResult.reason === "human_review" ? undefined : txResult.reason,
          sessionId: lastOut?.sessionId,
        });
        setExecState("paused");
        setFocusPane("left");
        break;
      }
    }
  }, [jobId, onDone, outputService, startPhase]);

  // ── Review callbacks ──

  const handleApprove = useCallback(() => {
    try {
      const jobData = ctx.jobStore.load(jobId);
      const wf = ctx.workflows[jobData.frontmatter.workflow];
      if (!wf) return;
      const currentPhase = jobData.frontmatter.current_phase ?? phase;
      const phaseConfig = getPhase(wf, currentPhase);
      const condition = phaseConfig?.type === "review" ? "approved" : "completed";
      const result = jobService.transition(jobId, parseTransitionCondition(condition), "");
      handleTransitionResult(result);
    } catch (e) {
      setStatusMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [jobId, ctx, phase, jobService, handleTransitionResult]);

  const handleReject = useCallback((feedback?: string) => {
    try {
      const jobData = ctx.jobStore.load(jobId);
      const wf = ctx.workflows[jobData.frontmatter.workflow];
      if (!wf) return;
      const currentPhase = jobData.frontmatter.current_phase ?? phase;
      const phaseConfig = getPhase(wf, currentPhase);
      const condition = phaseConfig?.type === "review" ? "rejected" : "failed";

      if (feedback?.trim()) {
        outputService.saveHumanFeedback(jobId, currentPhase, feedback, ctx.iterationStore.get(jobId));
      }

      const result = jobService.transition(jobId, parseTransitionCondition(condition), feedback ?? "");
      handleTransitionResult(result);
    } catch (e) {
      setStatusMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [jobId, ctx, phase, jobService, outputService, handleTransitionResult]);

  const handleContinue = useCallback(() => {
    const info = pauseInfoRef.current;
    if (!info) return;
    currentPhaseRef.current = info.nextPhase;
    setPauseInfo(null);
    setExecState("running");
    setFocusPane("right");
    startPhase(info.nextPhase);
  }, [startPhase]);

  // ── Signal handler ──

  useEffect(() => {
    signalHandlerRef.current = (msg: SignalMessage) => {
      if (msg.job_id && msg.job_id !== jobId) return;
      if (msg.event === "stop") {
        executionRef.current?.kill();
      }
      if (msg.event === "notification" && execStateRef.current === "paused") {
        handleContinue();
      }
    };
    return () => { signalHandlerRef.current = null; };
  }, [jobId, signalHandlerRef, execStateRef, handleContinue]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { executionRef.current?.kill(); };
  }, []);

  // Auto-copy selection
  useEffect(() => {
    const onSelection = () => {
      const selection = renderer.getSelection();
      if (selection && !selection.isDragging) {
        const text = selection.getSelectedText();
        if (text) renderer.copyToClipboardOSC52(text);
      }
    };
    renderer.on(CliRenderEvents.SELECTION, onSelection);
    return () => { renderer.off(CliRenderEvents.SELECTION, onSelection); };
  }, [renderer]);

  // ── Keyboard handler ──

  useKeyboard((event: KeyEvent) => {
    const state = execStateRef.current;

    if (event.name === "tab") {
      setFocusPane(focusPaneRef.current === "left" ? "right" : "left");
      event.preventDefault();
      return;
    }

    if (event.name === "escape") {
      if (state === "paused") {
        // InlineReview handles its own escape
        return;
      }
      executionRef.current?.kill();
      onDone();
      event.preventDefault();
      return;
    }

    if (state === "idle") {
      if (event.name === "return" || event.name === "enter") {
        setExecState("running");
        setFocusPane("right");
        startPhase(phase);
        event.preventDefault();
        return;
      }
      event.preventDefault();
      return;
    }

    if (state === "running") {
      event.preventDefault();
      return;
    }

    // paused state is handled by InlineReview
  });

  // ── Derived data ──

  const { job, wfConfig, iteration, phaseConfig } = useMemo(() => {
    let job: Job | null = null;
    let wfConfig: WorkflowConfig | undefined;
    let iteration = 0;
    let phaseConfig: PhaseConfig | undefined;
    try {
      job = ctx.jobStore.load(jobId);
      wfConfig = ctx.workflows[job.frontmatter.workflow];
      iteration = ctx.iterationStore.get(jobId);
      phaseConfig = wfConfig ? getPhase(wfConfig, currentPhaseRef.current) : undefined;
    } catch { /* ignore */ }
    return { job, wfConfig, iteration, phaseConfig };
  }, [jobId, ctx, displayLines, execState]);

  const currentPhaseName = currentPhaseRef.current;

  const diagramText = useMemo(() => {
    if (!wfConfig) return "";
    return wfConfig.phases.map((p, i) => {
      const isCurrent = p.name === currentPhaseName;
      const marker = isCurrent ? "●" : "○";
      const arrow = i < wfConfig.phases.length - 1 ? " → " : "";
      return `${marker} ${p.name}${arrow}`;
    }).join("");
  }, [wfConfig, currentPhaseName]);

  const jobBodyLines = useMemo(() => {
    if (!job?.body) return ["(なし)"];
    const logIdx = job.body.indexOf("## フェーズログ");
    const displayBody = logIdx >= 0 ? job.body.slice(0, logIdx).trimEnd() : job.body;
    return displayBody.split("\n");
  }, [job]);

  // ── Status bar ──

  const statusBarItems = useMemo((): StatusBarItem[] => {
    if (execState === "idle") {
      return [
        { key: "Enter", label: "実行開始" },
        { key: "Tab", label: "ペイン切替" },
        { key: "Esc", label: "一覧に戻る" },
      ];
    }
    if (execState === "running") {
      return [
        { key: "↑↓/Scroll", label: "スクロール" },
        { key: "Tab", label: "ペイン切替" },
        { key: "Esc", label: "一覧に戻る" },
      ];
    }
    const info = pauseInfo;
    if (!info) return [{ key: "Esc", label: "一覧に戻る" }];

    const isHumanReview = info.phaseType === "review" && info.reviewer === "human";
    const isAgentReview = info.phaseType === "review" && info.reviewer !== "human";

    if (isHumanReview) {
      return [
        { key: "Enter", label: "判断へ" },
        { key: "Tab", label: "ペイン切替" },
        { key: "Esc", label: "一覧に戻る" },
      ];
    }
    if (isAgentReview) {
      return [
        { key: "r/Enter", label: "レビューエージェント実行" },
        { key: "a", label: "直接承認" },
        { key: "x", label: "直接却下" },
        { key: "Tab", label: "ペイン切替" },
        { key: "Esc", label: "一覧に戻る" },
      ];
    }
    return [
      { key: "Enter", label: "次フェーズ実行" },
      { key: "Tab", label: "ペイン切替" },
      { key: "Esc", label: "一覧に戻る" },
    ];
  }, [execState, pauseInfo]);

  // ── Render ──

  const leftBorderColor = focusPane === "left" ? COLOR_CYAN : COLOR_GRAY;
  const rightBorderColor = focusPane === "right" ? COLOR_CYAN : COLOR_GRAY;

  return (
    <box width="100%" height="100%" flexDirection="column">
      {/* Header */}
      <box width="100%" height={1} backgroundColor={COLOR_HEADER_BG}>
        <text fg={COLOR_CYAN} attributes={ATTR_BOLD}>
          {` ${job?.frontmatter.id ?? jobId} | ${truncateStr(job?.frontmatter.title ?? "", 40)} | ${currentPhaseName} (iter: ${iteration})`}
        </text>
      </box>

      {/* Main content */}
      <box flexDirection="row" flexGrow={1}>
        {/* Left pane */}
        <box width="35%" flexDirection="column" borderStyle="single" borderColor={leftBorderColor}>
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            <text fg={COLOR_GRAY} attributes={ATTR_BOLD}>ワークフロー</text>
            <text fg={COLOR_YELLOW}>{job?.frontmatter.workflow ?? ""}</text>
            <text fg={COLOR_GRAY}>{diagramText || "フェーズなし"}</text>
          </box>

          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            <text fg={COLOR_GRAY} attributes={ATTR_BOLD}>フェーズ詳細</text>
            <box flexDirection="row" height={1}>
              <text fg={COLOR_GRAY}>名前: </text>
              <text fg={COLOR_CYAN}>{currentPhaseName}</text>
            </box>
            <box flexDirection="row" height={1}>
              <text fg={COLOR_GRAY}>タイプ: </text>
              <text fg={COLOR_YELLOW}>{phaseConfig?.type ?? "-"}</text>
            </box>
            {phaseConfig?.agent ? (
              <box flexDirection="row" height={1}>
                <text fg={COLOR_GRAY}>エージェント: </text>
                <text fg={COLOR_GREEN}>{phaseConfig.agent}</text>
              </box>
            ) : null}
            {phaseConfig?.reviewer ? (
              <box flexDirection="row" height={1}>
                <text fg={COLOR_GRAY}>レビュアー: </text>
                <text fg={COLOR_GREEN}>{phaseConfig.reviewer}</text>
              </box>
            ) : null}
            {phaseConfig?.description ? (
              <text fg={COLOR_DARK_GRAY}>{phaseConfig.description}</text>
            ) : null}
          </box>

          {/* Inline review controls */}
          {execState === "paused" && pauseInfo && (
            <InlineReview
              info={pauseInfo}
              onApprove={handleApprove}
              onReject={handleReject}
              onContinue={handleContinue}
              onEscape={onDone}
            />
          )}

          {statusMsg ? (
            <box paddingLeft={1}>
              <text fg={COLOR_RED}>{statusMsg}</text>
            </box>
          ) : null}

          {/* Job body */}
          <box flexDirection="column" paddingLeft={1} paddingRight={1} flexGrow={1}>
            <text fg={COLOR_GRAY} attributes={ATTR_BOLD}>ジョブ本文</text>
            <scrollbox flexGrow={1} scrollY focused={focusPane === "left"}>
              {jobBodyLines.map((line, i) => (
                <text key={i} fg={COLOR_WHITE}>{line || " "}</text>
              ))}
            </scrollbox>
          </box>
        </box>

        {/* Right pane */}
        <box flexGrow={1} flexDirection="column" borderStyle="single" borderColor={rightBorderColor}>
          {execState === "idle" ? (
            <box flexGrow={1} alignItems="center" justifyContent="center">
              <text fg={COLOR_GRAY}>Enter を押してフェーズを実行開始</text>
            </box>
          ) : (
            <scrollbox
              ref={scrollBoxRef}
              flexGrow={1}
              scrollY
              stickyScroll
              stickyStart="bottom"
              paddingLeft={1}
              paddingRight={1}
              focused={focusPane === "right"}
            >
              {displayLines.map((line, i) => (
                <OutputLine key={i} spans={line} />
              ))}
            </scrollbox>
          )}
        </box>
      </box>

      {/* Status bar */}
      <StatusBar items={statusBarItems} />
    </box>
  );
}
