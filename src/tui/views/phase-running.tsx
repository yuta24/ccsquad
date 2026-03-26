import type { KeyEvent } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { CliRenderEvents } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { spawn, type IPty } from "bun-pty";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { MutableRefObject } from "react";
import type { SquadConfig, WorkflowConfig, PhaseType } from "../../config.js";
import { parseTransitionCondition } from "../../config.js";
import type { Job } from "../../job.js";
import type { JobStore } from "../../job.js";
import type { IterationStore } from "../../iteration.js";
import { resolveAndExecuteTransition } from "../../service/transition.js";
import { parseStreamJsonResult } from "../../result.js";
import type { OutputStore } from "../../output.js";
import { buildTaskPrompt, buildReviewPrompt, buildResumePrompt } from "../../service/prompt-builder.js";
import type { SignalMessage } from "../../service/signal-server.js";
import { PhaseHeader } from "../components/phase-header.js";
import { StatusBar } from "../components/status-bar.js";
import type { TransitionInfo } from "../constants.js";
import { ATTR_BOLD, COLOR_CYAN, COLOR_GREEN, COLOR_RED, COLOR_DARK_GRAY, COLOR_WHITE } from "../constants.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";

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
  onTransition: (info: TransitionInfo) => void;
  onDone: () => void;
}

export function PhaseRunningView({
  jobId, phase, store, config, iterationStore,
  projectRoot, outputStore, signalHandlerRef,
  onTransition, onDone,
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
        case "pause":
          isProcessingRef.current = false;
          onTransition({
            prevPhase: currentPhaseRef.current,
            result: condition,
            message,
            nextPhase: txResult.nextPhase,
            description: txResult.phaseConfig.description,
            agent: txResult.phaseConfig.agent,
            reviewer: txResult.phaseConfig.reviewer,
            phaseType: txResult.phaseConfig.type,
            reason: txResult.reason === "human_review" ? undefined : txResult.reason,
            sessionId: outputStore.findLastByPhase(jobId, currentPhaseRef.current)?.sessionId,
          });
          break;
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
  }, [jobId, store, config, iterationStore, onTransition, onDone, outputStore]);

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

    if (sessionId) {
      let feedback: string;
      if (phaseType === "task") {
        const allOutputs = outputStore.loadForJob(jobId);
        const reviewOutputs = allOutputs.filter((o) => o.phase !== phaseName);
        const lastReviewOutput = reviewOutputs.length > 0 ? reviewOutputs[reviewOutputs.length - 1] : null;
        feedback = lastReviewOutput?.content ?? "";
      } else {
        const allOutputs = outputStore.loadForJob(jobId);
        const taskOutputs = allOutputs.filter((o) => o.phase !== phaseName);
        const lastTaskOutput = taskOutputs.length > 0 ? taskOutputs[taskOutputs.length - 1] : null;
        feedback = lastTaskOutput?.content ?? "";
      }

      prompt = buildResumePrompt({ phase: phaseName, phaseType, phasePrompt: phaseConfig.prompt, iteration, feedback });
      args = ["claude", "-p", "--verbose", "--permission-mode", "auto", "--resume", sessionId, "--output-format", "stream-json", prompt];
    } else {
      const previousOutputs = outputStore.loadForJob(jobId);

      if (phaseType === "review") {
        const taskOutputs = previousOutputs.filter((o) => {
          const pc = wf?.getPhase(o.phase);
          return pc?.type === "task";
        });
        const lastTaskOutput = taskOutputs.length > 0 ? taskOutputs[taskOutputs.length - 1] : null;
        const taskOutput = lastTaskOutput?.content ?? "";

        prompt = buildReviewPrompt({
          jobId,
          title: jobData.frontmatter.title,
          phase: phaseName,
          phaseDescription: phaseConfig.description,
          phasePrompt: phaseConfig.prompt,
          iteration,
          jobBody: jobData.body,
          taskOutput,
          previousOutputs,
          includeOutputPhases: phaseConfig.context?.include_outputs,
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
          previousOutputs,
          includeOutputPhases: phaseConfig.context?.include_outputs,
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

      const result = phaseType === "task"
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
    };
    return () => { signalHandlerRef.current = null; };
  }, [jobId, signalHandlerRef]);

  // Start agent on mount
  useEffect(() => {
    currentPhaseRef.current = phase;
    spawnAgentForPhase(phase);
    return () => {
      if (ptyRef.current) {
        try { ptyRef.current.kill(); } catch { /* ignore */ }
        ptyRef.current = null;
      }
    };
  }, []);

  // Auto-copy selection to clipboard via OSC 52 when selection changes
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

  useKeyboard((event: KeyEvent) => {
    if (event.name === "escape") {
      if (ptyRef.current) {
        try { ptyRef.current.kill(); } catch { /* ignore */ }
      }
      onDone();
      event.preventDefault();
      return;
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
  }, [jobId, store, config, iterationStore, displayLines]);

  return (
    <box width="100%" height="100%" flexDirection="column">
      {job && <PhaseHeader job={job} workflowConfig={wfConfig} iteration={iteration} />}
      <scrollbox
        ref={scrollBoxRef}
        flexGrow={1}
        borderStyle="single"
        borderColor={COLOR_CYAN}
        scrollY
        stickyScroll
        stickyStart="bottom"
        paddingLeft={1}
        paddingRight={1}
        focused
      >
        {displayLines.map((line, i) => (
          <OutputLine key={i} spans={line} />
        ))}
      </scrollbox>
      <StatusBar items={[
        { key: "↑↓/Scroll", label: "スクロール" },
        { key: "Esc", label: "一覧に戻る" },
      ]} />
    </box>
  );
}
