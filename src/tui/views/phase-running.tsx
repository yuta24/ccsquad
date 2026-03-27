import type { KeyEvent } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { CliRenderEvents } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { join } from "node:path";
import { spawn, type IPty } from "bun-pty";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { MutableRefObject } from "react";
import type { SquadConfig, WorkflowConfig, PhaseType, PhaseConfig } from "../../config.js";
import { parseTransitionCondition, isTaskLikeType, getOutputFormat } from "../../config.js";
import type { Job } from "../../job.js";
import type { JobStore } from "../../job.js";
import type { IterationStore } from "../../iteration.js";
import { resolveAndExecuteTransition } from "../../service/transition.js";
import { parseStreamJsonResult } from "../../result.js";
import type { OutputStore } from "../../output.js";
import { buildTaskPrompt, buildReviewPrompt, buildResumePrompt } from "../../service/prompt-builder.js";
import type { SignalMessage } from "../../service/signal-server.js";
import { StatusBar } from "../components/status-bar.js";
import type { TransitionInfo, StatusBarItem } from "../constants.js";
import {
  ATTR_BOLD, COLOR_CYAN, COLOR_GREEN, COLOR_RED, COLOR_DARK_GRAY, COLOR_WHITE,
  COLOR_HEADER_BG, COLOR_GRAY, COLOR_YELLOW, truncateStr,
} from "../constants.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { useSyncedState } from "../hooks/use-synced-state.js";

// ── Styled span model ──

interface TextSpan {
  text: string;
  color: string;
  attrs: number;
}

type DisplayLine = TextSpan[];

// ── ANSI → DisplayLine parser ──

const COLOR_DIM = "#6a6a6a";

function parseAnsiToSpans(text: string): DisplayLine {
  const spans: TextSpan[] = [];
  let color = COLOR_WHITE;
  let attrs = 0;
  let buf = "";

  const flush = () => {
    if (buf) {
      spans.push({ text: buf, color, attrs });
      buf = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      flush();
      const end = text.indexOf("m", i + 2);
      if (end === -1) { i++; continue; }
      const codes = text.slice(i + 2, end).split(";").map(Number);
      for (const code of codes) {
        switch (code) {
          case 0: color = COLOR_WHITE; attrs = 0; break;
          case 1: attrs |= ATTR_BOLD; break;
          case 2: color = COLOR_DIM; break;
          case 31: color = COLOR_RED; break;
          case 32: color = COLOR_GREEN; break;
          case 36: color = COLOR_CYAN; break;
        }
      }
      i = end + 1;
    } else {
      buf += text[i];
      i++;
    }
  }
  flush();
  return spans;
}

// ── stream-json event formatter ──

const ESC_RESET = "\x1b[0m";
const ESC_DIM = "\x1b[2m";
const ESC_BOLD = "\x1b[1m";
const ESC_CYAN = "\x1b[36m";
const ESC_GREEN = "\x1b[32m";
const ESC_RED = "\x1b[31m";

function formatStreamEvent(line: string): string[] {
  if (!line.startsWith("{")) return [];
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }

  const type = event.type as string | undefined;
  if (type === "system" || type === "rate_limit_event" || type === "result") {
    return [];
  }

  if (type === "assistant") {
    const msg = event.message as Record<string, unknown> | undefined;
    const content = (msg?.content as Array<Record<string, unknown>>) ?? [];
    const result: string[] = [];
    for (const block of content) {
      const bt = block.type as string;
      if (bt === "thinking") {
        const t = (block.thinking as string) ?? "";
        if (t) for (const l of t.split("\n")) result.push(`${ESC_DIM}${l}${ESC_RESET}`);
      } else if (bt === "text") {
        const t = (block.text as string) ?? "";
        if (t) for (const l of t.split("\n")) result.push(l);
      } else if (bt === "tool_use") {
        const name = (block.name as string) ?? "?";
        const input = block.input as Record<string, unknown> | undefined;
        const keys = input ? Object.keys(input).join(", ") : "";
        result.push(`${ESC_BOLD}${ESC_CYAN}▶ ${name}${ESC_RESET}${ESC_DIM}(${keys})${ESC_RESET}`);
      }
    }
    return result;
  }

  if (type === "user") {
    const msg = event.message as Record<string, unknown> | undefined;
    const content = (msg?.content as Array<Record<string, unknown>>) ?? [];
    const result: string[] = [];
    for (const block of content) {
      if ((block.type as string) === "tool_result") {
        const isError = block.is_error === true;
        const raw = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        const preview = raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
        result.push(isError
          ? `${ESC_RED}✗ ${preview}${ESC_RESET}`
          : `${ESC_GREEN}✓${ESC_RESET} ${ESC_DIM}${preview}${ESC_RESET}`);
      }
    }
    return result;
  }

  return [];
}

// ── Line component ──

function OutputLine({ spans }: { spans: DisplayLine }) {
  if (spans.length === 0) return <box height={1} />;
  if (spans.length === 1) {
    return <text selectable fg={spans[0].color} attributes={spans[0].attrs}>{spans[0].text}</text>;
  }
  return (
    <box height={1} flexDirection="row">
      {spans.map((s, i) => (
        <text key={i} selectable fg={s.color} attributes={s.attrs}>{s.text}</text>
      ))}
    </box>
  );
}

// ── Types ──

type ExecutionState = "idle" | "running" | "paused";
type FocusPane = "left" | "right";
type ReviewMode = "browse" | "decide" | "feedback";

// ── Main component ──

interface PhaseRunningViewProps {
  jobId: string;
  phase: string;
  store: JobStore;
  config: SquadConfig;
  iterationStore: IterationStore;
  projectRoot: string;
  outputStore: OutputStore;
  signalHandlerRef: MutableRefObject<((msg: SignalMessage) => void) | null>;
  onDone: () => void;
}

export function PhaseRunningView({
  jobId, phase, store, config, iterationStore,
  projectRoot, outputStore, signalHandlerRef,
  onDone,
}: PhaseRunningViewProps) {
  const renderer = useRenderer();
  const [displayLines, setDisplayLines] = useState<DisplayLine[]>([]);
  const ptyRef = useRef<IPty | null>(null);
  const isProcessingRef = useRef(false);
  const currentPhaseRef = useRef(phase);
  const exitedRef = useRef(false);
  const rawOutputRef = useRef("");
  const lineBufferRef = useRef("");
  const displayLinesRef = useRef<DisplayLine[]>([]);
  const scrollBoxRef = useRef<ScrollBoxRenderable | null>(null);
  const { cols } = useTerminalSize();

  // Execution state
  const [execState, setExecState, execStateRef] = useSyncedState<ExecutionState>("idle");
  const [focusPane, setFocusPane, focusPaneRef] = useSyncedState<FocusPane>("left");

  // Pause-review state
  const [pauseInfo, setPauseInfo, pauseInfoRef] = useSyncedState<TransitionInfo | null>(null);
  const [reviewMode, setReviewMode, reviewModeRef] = useSyncedState<ReviewMode>("browse");
  const [feedbackText, setFeedbackText, feedbackTextRef] = useSyncedState("");
  const [statusMsg, setStatusMsg] = useState("");

  // ── Transition handling (with integrated pause-review) ──

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
          // Auto-continue: start next phase
          currentPhaseRef.current = txResult.nextPhase;
          setPauseInfo(null);
          setReviewMode("browse");
          setExecState("running");
          setFocusPane("right");
          spawnAgentForPhase(txResult.nextPhase);
          break;
        case "pause":
          if (txResult.reason === "human_review") {
            // Re-enter paused state for the new phase
            const lastOut = outputStore.findLastByPhase(jobId, jobData.frontmatter.current_phase ?? "");
            setPauseInfo({
              prevPhase: jobData.frontmatter.current_phase ?? "",
              result: condition,
              message: message ?? "",
              nextPhase: txResult.nextPhase,
              description: txResult.phaseConfig.description,
              agent: txResult.phaseConfig.agent,
              reviewer: txResult.phaseConfig.reviewer,
              phaseType: txResult.phaseConfig.type,
              sessionId: lastOut?.sessionId,
            });
            setReviewMode("browse");
            setExecState("paused");
            setFocusPane("left");
          } else {
            // max_iterations - wait for user action
            setPauseInfo({
              prevPhase: jobData.frontmatter.current_phase ?? "",
              result: condition,
              message: message ?? "",
              nextPhase: txResult.nextPhase,
              description: txResult.phaseConfig.description,
              agent: txResult.phaseConfig.agent,
              reviewer: txResult.phaseConfig.reviewer,
              phaseType: txResult.phaseConfig.type,
              reason: "max_iterations",
            });
            setReviewMode("browse");
            setExecState("paused");
            setFocusPane("left");
          }
          break;
      }
    } catch (e) {
      setStatusMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, store, config, iterationStore, outputStore, onDone]);

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

  // ── Process transition from agent exit ──

  const processTransition = useCallback((result: string, message: string) => {
    try {
      const jobData = store.load(jobId);
      const wf = config.getWorkflow(jobData.frontmatter.workflow);
      if (!wf) {
        isProcessingRef.current = false;
        return;
      }

      const condition = parseTransitionCondition(result);
      const txResult = resolveAndExecuteTransition(wf, store, iterationStore, jobId, condition, message);

      switch (txResult.type) {
        case "done":
          isProcessingRef.current = false;
          onDone();
          break;
        case "pause": {
          isProcessingRef.current = false;
          const prevPhase = currentPhaseRef.current;
          const info: TransitionInfo = {
            prevPhase,
            result: condition,
            message,
            nextPhase: txResult.nextPhase,
            description: txResult.phaseConfig.description,
            agent: txResult.phaseConfig.agent,
            reviewer: txResult.phaseConfig.reviewer,
            phaseType: txResult.phaseConfig.type,
            reason: txResult.reason === "human_review" ? undefined : txResult.reason,
            sessionId: outputStore.findLastByPhase(jobId, prevPhase)?.sessionId,
          };
          setPauseInfo(info);
          setReviewMode("browse");
          setExecState("paused");
          setFocusPane("left");
          break;
        }
        case "continue": {
          currentPhaseRef.current = txResult.nextPhase;
          isProcessingRef.current = false;
          spawnAgentForPhase(txResult.nextPhase);
          break;
        }
      }
    } catch {
      isProcessingRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, store, config, iterationStore, onDone, outputStore]);

  // ── Spawn agent ──

  const spawnAgentForPhase = useCallback((phaseName: string) => {
    if (ptyRef.current) {
      try { ptyRef.current.kill(); } catch { /* ignore */ }
      ptyRef.current = null;
    }
    exitedRef.current = false;
    rawOutputRef.current = "";
    lineBufferRef.current = "";
    displayLinesRef.current = [];
    setDisplayLines([]);

    let jobData: Job;
    try {
      jobData = store.load(jobId);
    } catch {
      return;
    }

    const wf = config.getWorkflow(jobData.frontmatter.workflow);
    const phaseConfig = wf?.getPhase(phaseName);
    if (!phaseConfig) return;

    const phaseType: PhaseType = phaseConfig.type;
    const agentName = phaseConfig.agent ?? "claude";
    const iteration = iterationStore.get(jobId);

    const lastOutput = outputStore.findLastByPhase(jobId, phaseName);
    const sessionId = lastOutput?.sessionId;

    let prompt: string;
    let args: string[];

    const outputFiles = outputStore.listFilesForJob(jobId);
    const jobFilePath = join(projectRoot, ".ccsquad", "jobs", `${jobId}.md`);

    if (sessionId) {
      // Find the latest output from a different phase as feedback reference
      const feedbackFiles = outputFiles.filter((f) => f.phase !== phaseName);
      const lastFeedbackFile = feedbackFiles.length > 0 ? feedbackFiles[feedbackFiles.length - 1] : null;
      const feedbackRef = lastFeedbackFile ? `以下のファイルを参照してください: \`${lastFeedbackFile.filePath}\`` : "";

      prompt = buildResumePrompt({ phase: phaseName, phaseType, phasePrompt: phaseConfig.prompt, iteration, feedback: feedbackRef });
      args = ["claude", "-p", "--verbose", "--permission-mode", "auto", "--resume", sessionId, "--output-format", "stream-json", prompt];
    } else {

      if (phaseType === "review") {
        // Find the last task-like output file for review
        const taskOutputFiles = outputFiles.filter((f) => {
          const pc = wf?.getPhase(f.phase);
          return pc ? isTaskLikeType(pc.type) : false;
        });
        const lastTaskOutputFile = taskOutputFiles.length > 0 ? taskOutputFiles[taskOutputFiles.length - 1] : null;

        if (!lastTaskOutputFile) {
          // No task output to review — skip
          return;
        }

        prompt = buildReviewPrompt({
          jobId,
          title: jobData.frontmatter.title,
          phase: phaseName,
          phaseDescription: phaseConfig.description,
          phasePrompt: phaseConfig.prompt,
          iteration,
          jobBody: jobData.body,
          jobFilePath,
          taskOutputFile: lastTaskOutputFile,
          outputFiles,
          outputFormat: getOutputFormat(phaseConfig),
        });
        args = ["claude", "-p", "--verbose", "--permission-mode", "auto", "--agent", agentName, "--output-format", "stream-json", prompt];
      } else {
        prompt = buildTaskPrompt({
          jobId,
          title: jobData.frontmatter.title,
          phase: phaseName,
          phaseDescription: phaseConfig.description,
          phasePrompt: phaseConfig.prompt,
          iteration,
          jobBody: jobData.body,
          jobFilePath,
          outputFiles,
          outputFormat: getOutputFormat(phaseConfig),
        });
        args = ["claude", "-p", "--verbose", "--permission-mode", "auto", "--agent", agentName, "--output-format", "stream-json", prompt];
      }
    }

    const pty = spawn(args[0], args.slice(1), {
      name: "xterm-256color",
      cols: Math.max(cols, 80),
      rows: 24,
      env: { ...process.env, TERM: "xterm-256color", CCSQUAD_ROOT: projectRoot, JOB_ID: jobId },
      cwd: process.cwd(),
    });
    ptyRef.current = pty;

    pty.onData((data: string) => {
      rawOutputRef.current += data;
      lineBufferRef.current += data;

      const lines = lineBufferRef.current.split("\n");
      lineBufferRef.current = lines.pop() ?? "";

      let added = false;
      for (const line of lines) {
        const formatted = formatStreamEvent(line.replace(/\r$/, ""));
        for (const textLine of formatted) {
          displayLinesRef.current.push(parseAnsiToSpans(textLine));
          added = true;
        }
      }

      if (added) {
        setDisplayLines([...displayLinesRef.current]);
      }
    });

    pty.onExit((exitInfo: { exitCode: number }) => {
      exitedRef.current = true;
      const exitCode = exitInfo.exitCode;

      let parsedSessionId: string | undefined;
      let content = "";

      try {
        const printResult = parseStreamJsonResult(rawOutputRef.current);
        if (printResult) {
          parsedSessionId = printResult.sessionId || undefined;
          content = printResult.content || "";
        }
      } catch {
        content = "";
      }

      const result = isTaskLikeType(phaseType)
        ? (exitCode === 0 ? "completed" : "failed")
        : (exitCode === 0 ? "approved" : "rejected");

      try {
        outputStore.save(jobId, {
          phase: phaseName,
          executor: agentName,
          result,
          sessionId: parsedSessionId,
          iteration,
          timestamp: new Date().toISOString(),
          content,
        });
      } catch {
        isProcessingRef.current = false;
        return;
      }

      processTransition(result, content);
    });
  }, [jobId, store, config, iterationStore, projectRoot, outputStore, processTransition, cols]);

  // Signal handler
  useEffect(() => {
    signalHandlerRef.current = (msg: SignalMessage) => {
      if (msg.job_id && msg.job_id !== jobId) return;
      if (msg.event === "stop" && ptyRef.current && !exitedRef.current) {
        try { ptyRef.current.kill(); } catch { /* ignore */ }
      }
      if (msg.event === "notification" && execStateRef.current === "paused") {
        // Auto-run on notification while paused (same as pause-review)
        const info = pauseInfoRef.current;
        if (info) {
          currentPhaseRef.current = info.nextPhase;
          setPauseInfo(null);
          setReviewMode("browse");
          setExecState("running");
          setFocusPane("right");
          spawnAgentForPhase(info.nextPhase);
        }
      }
    };
    return () => { signalHandlerRef.current = null; };
  }, [jobId, signalHandlerRef, execStateRef, pauseInfoRef, setPauseInfo, setReviewMode, setExecState, setFocusPane, spawnAgentForPhase]);

  // Initialize refs on mount (do NOT auto-start)
  useEffect(() => {
    currentPhaseRef.current = phase;
    return () => {
      if (ptyRef.current) {
        try { ptyRef.current.kill(); } catch { /* ignore */ }
        ptyRef.current = null;
      }
    };
  }, []);

  // Auto-copy selection to clipboard via OSC 52
  useEffect(() => {
    const onSelection = () => {
      const selection = renderer.getSelection();
      if (selection && !selection.isDragging) {
        const text = selection.getSelectedText();
        if (text) {
          renderer.copyToClipboardOSC52(text);
        }
      }
    };
    renderer.on(CliRenderEvents.SELECTION, onSelection);
    return () => { renderer.off(CliRenderEvents.SELECTION, onSelection); };
  }, [renderer]);

  // ── Keyboard handler ──

  useKeyboard((event: KeyEvent) => {
    const state = execStateRef.current;
    const focus = focusPaneRef.current;

    // Tab: toggle focus pane
    if (event.name === "tab") {
      setFocusPane(focus === "left" ? "right" : "left");
      event.preventDefault();
      return;
    }

    // Escape: kill process if running, go back to job list
    if (event.name === "escape") {
      if (state === "paused" && reviewModeRef.current === "feedback") {
        setReviewMode("decide");
        event.preventDefault();
        return;
      }
      if (state === "paused" && reviewModeRef.current === "decide") {
        setReviewMode("browse");
        event.preventDefault();
        return;
      }
      if (ptyRef.current) {
        try { ptyRef.current.kill(); } catch { /* ignore */ }
      }
      onDone();
      event.preventDefault();
      return;
    }

    // ── Idle state ──
    if (state === "idle") {
      if (event.name === "return" || event.name === "enter") {
        setExecState("running");
        setFocusPane("right");
        spawnAgentForPhase(phase);
        event.preventDefault();
        return;
      }
      event.preventDefault();
      return;
    }

    // ── Running state ──
    if (state === "running") {
      // All scrolling handled by scrollbox focused state
      event.preventDefault();
      return;
    }

    // ── Paused state ──
    if (state === "paused") {
      const info = pauseInfoRef.current;
      if (!info) { event.preventDefault(); return; }

      const isHumanReview = info.phaseType === "review" && info.reviewer === "human";
      const isAgentReview = info.phaseType === "review" && info.reviewer !== "human";
      const currentReviewMode = reviewModeRef.current;

      if (isHumanReview) {
        if (currentReviewMode === "browse") {
          if (event.name === "return" || event.name === "enter") {
            setReviewMode("decide");
            event.preventDefault();
            return;
          }
        } else if (currentReviewMode === "decide") {
          if (event.name === "a") { executeApprove(); event.preventDefault(); return; }
          if (event.name === "x") { setReviewMode("feedback"); setFeedbackText(""); event.preventDefault(); return; }
        } else if (currentReviewMode === "feedback") {
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
      } else if (isAgentReview) {
        if (event.name === "r" || event.name === "return" || event.name === "enter") {
          currentPhaseRef.current = info.nextPhase;
          setPauseInfo(null);
          setReviewMode("browse");
          setExecState("running");
          setFocusPane("right");
          spawnAgentForPhase(info.nextPhase);
          event.preventDefault();
          return;
        }
        if (event.name === "a") { executeApprove(); event.preventDefault(); return; }
        if (event.name === "x") { executeReject(); event.preventDefault(); return; }
      } else {
        // max_iterations pause
        if (event.name === "return" || event.name === "enter") {
          currentPhaseRef.current = info.nextPhase;
          setPauseInfo(null);
          setReviewMode("browse");
          setExecState("running");
          setFocusPane("right");
          spawnAgentForPhase(info.nextPhase);
          event.preventDefault();
          return;
        }
      }

      event.preventDefault();
      return;
    }

    event.preventDefault();
  });

  // ── Derived data ──

  const { job, wfConfig, iteration, phaseConfig } = useMemo(() => {
    let job: Job | null = null;
    let wfConfig: WorkflowConfig | undefined;
    let iteration = 0;
    let phaseConfig: PhaseConfig | undefined;
    try {
      job = store.load(jobId);
      wfConfig = config.getWorkflow(job.frontmatter.workflow);
      iteration = iterationStore.get(jobId);
      phaseConfig = wfConfig?.getPhase(currentPhaseRef.current);
    } catch {
      // ignore
    }
    return { job, wfConfig, iteration, phaseConfig };
  }, [jobId, store, config, iterationStore, displayLines, execState]);

  const currentPhaseName = currentPhaseRef.current;

  // Build workflow diagram text
  const diagramText = useMemo(() => {
    if (!wfConfig) return "";
    return wfConfig.phases.map((p, i) => {
      const isCurrent = p.name === currentPhaseName;
      const marker = isCurrent ? "●" : "○";
      const arrow = i < wfConfig.phases.length - 1 ? " → " : "";
      return `${marker} ${p.name}${arrow}`;
    }).join("");
  }, [wfConfig, currentPhaseName]);

  // Job body lines for left pane display
  const jobBodyLines = useMemo(() => {
    if (!job?.body) return ["(なし)"];
    // Extract body before phase log section for cleaner display
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
    // paused
    const info = pauseInfo;
    if (!info) return [{ key: "Esc", label: "一覧に戻る" }];

    const isHumanReview = info.phaseType === "review" && info.reviewer === "human";
    const isAgentReview = info.phaseType === "review" && info.reviewer !== "human";

    if (isHumanReview) {
      if (reviewMode === "browse") {
        return [
          { key: "Enter", label: "判断へ" },
          { key: "Tab", label: "ペイン切替" },
          { key: "Esc", label: "一覧に戻る" },
        ];
      }
      if (reviewMode === "decide") {
        return [
          { key: "a", label: "承認" },
          { key: "x", label: "却下" },
          { key: "Esc", label: "閲覧に戻る" },
        ];
      }
      // feedback
      return [
        { key: "Ctrl+Enter", label: "却下を確定" },
        { key: "Esc", label: "判断に戻る" },
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
    // max_iterations
    return [
      { key: "Enter", label: "次フェーズ実行" },
      { key: "Tab", label: "ペイン切替" },
      { key: "Esc", label: "一覧に戻る" },
    ];
  }, [execState, pauseInfo, reviewMode]);

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

      {/* Main content - horizontal split */}
      <box flexDirection="row" flexGrow={1}>
        {/* Left pane */}
        <box width="35%" flexDirection="column" borderStyle="single" borderColor={leftBorderColor}>
          {/* Workflow section */}
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            <text fg={COLOR_GRAY} attributes={ATTR_BOLD}>ワークフロー</text>
            <text fg={COLOR_YELLOW}>{job?.frontmatter.workflow ?? ""}</text>
            <text fg={COLOR_GRAY}>{diagramText || "フェーズなし"}</text>
          </box>

          {/* Phase details */}
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

          {/* Pause review controls (when paused) */}
          {execState === "paused" && pauseInfo && (
            <box flexDirection="column" paddingLeft={1} paddingRight={1}>
              <text fg={COLOR_YELLOW} attributes={ATTR_BOLD}>
                {pauseInfo.reason === "max_iterations" ? "⚠ イテレーション上限" : "⏸ レビュー待ち"}
              </text>
              <box flexDirection="row" height={1}>
                <text fg={COLOR_GRAY}>前フェーズ: </text>
                <text fg={COLOR_WHITE}>{pauseInfo.prevPhase}</text>
                <text fg={COLOR_GRAY}> → </text>
                <text fg={pauseInfo.result === "completed" || pauseInfo.result === "approved" ? COLOR_GREEN : COLOR_RED}>
                  {pauseInfo.result}
                </text>
              </box>
              <box flexDirection="row" height={1}>
                <text fg={COLOR_GRAY}>次フェーズ: </text>
                <text fg={COLOR_YELLOW}>{pauseInfo.nextPhase}</text>
              </box>

              {reviewMode === "decide" && (
                <box flexDirection="column">
                  <box height={1} />
                  <text fg={COLOR_WHITE}>  [a] 承認  [x] 却下</text>
                </box>
              )}

              {reviewMode === "feedback" && (
                <box flexDirection="column" flexGrow={1}>
                  <box height={1} />
                  <text fg={COLOR_CYAN} attributes={ATTR_BOLD}>却下理由:</text>
                  <box flexGrow={1} borderStyle="single" borderColor={COLOR_GRAY} paddingLeft={1}>
                    <text fg={COLOR_WHITE}>{feedbackText}█</text>
                  </box>
                </box>
              )}

              {statusMsg ? <text fg={COLOR_RED}>{statusMsg}</text> : null}
            </box>
          )}

          {/* Job body (scrollable, takes remaining space) */}
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
