import type { KeyEvent, OptimizedBuffer } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { PersistentTerminal } from "ghostty-opentui";
import { spawn, type IPty } from "bun-pty";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { MutableRefObject } from "react";
import type { SquadConfig, WorkflowConfig, PhaseType } from "../../config.js";
import { parseTransitionCondition } from "../../config.js";
import type { Job } from "../../job.js";
import type { JobStore } from "../../job.js";
import type { IterationStore } from "../../iteration.js";
import { resolveAndExecuteTransition } from "../../service/transition.js";
import { parsePrintOutputFromText } from "../../result.js";
import type { OutputStore } from "../../output.js";
import { buildTaskPrompt, buildReviewPrompt, buildResumePrompt } from "../../service/prompt-builder.js";
import type { SignalMessage } from "../../service/signal-server.js";
import { renderTerminalToBuffer } from "../terminal-render.js";
import { PhaseHeader } from "../components/phase-header.js";
import { StatusBar } from "../components/status-bar.js";
import type { TransitionInfo } from "../constants.js";
import { COLOR_CYAN } from "../constants.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";

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
  const [_tick, setTick] = useState(0);
  const ptyRef = useRef<IPty | null>(null);
  const termRef = useRef<PersistentTerminal | null>(null);
  const isProcessingRef = useRef(false);
  const currentPhaseRef = useRef(phase);
  const exitedRef = useRef(false);
  const { cols, rows } = useTerminalSize();

  // Resize PTY and terminal when terminal size changes
  useEffect(() => {
    if (ptyRef.current) {
      try { ptyRef.current.resize(cols, rows - 5); } catch { /* ignore */ }
    }
    if (termRef.current) {
      try { (termRef.current as any).resize?.(cols, rows - 5); } catch { /* ignore */ }
    }
  }, [cols, rows]);

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
    // Clean up previous PTY/terminal
    if (ptyRef.current) {
      try { ptyRef.current.kill(); } catch { /* ignore */ }
      ptyRef.current = null;
    }
    if (termRef.current) {
      try { termRef.current.destroy(); } catch { /* ignore */ }
      termRef.current = null;
    }
    exitedRef.current = false;

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

    // Determine if this is a resume
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
      args = ["claude", "-p", "--resume", sessionId, "--output-format", "json", prompt];
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
        args = ["claude", "-p", "--agent", agentName, "--output-format", "json", prompt];
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
        args = ["claude", "-p", "--agent", agentName, "--output-format", "json", prompt];
      }
    }

    // Create PersistentTerminal and PTY
    const termCols = cols;
    const termRows = Math.max(rows - 5, 10); // reserve space for header + status bar
    const term = new PersistentTerminal({ cols: termCols, rows: termRows });
    termRef.current = term;

    const pty = spawn(args[0], args.slice(1), {
      name: "xterm-256color",
      cols: termCols,
      rows: termRows,
      env: { ...process.env, TERM: "xterm-256color", CCSQUAD_ROOT: projectRoot, JOB_ID: jobId },
      cwd: process.cwd(),
    });
    ptyRef.current = pty;

    pty.onData((data: string) => {
      term.feed(data);
      setTick((t) => t + 1);
    });

    pty.onExit((exitInfo: { exitCode: number }) => {
      exitedRef.current = true;
      const exitCode = exitInfo.exitCode;

      // Extract output from terminal text
      let parsedSessionId: string | undefined;
      let content = "";

      try {
        const termText = (term as any).getText?.() ?? "";
        const printResult = parsePrintOutputFromText(termText);
        if (printResult) {
          parsedSessionId = printResult.sessionId || undefined;
          content = printResult.content || termText;
        } else {
          content = termText;
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
  }, [jobId, store, config, iterationStore, projectRoot, outputStore, processTransition, cols, rows]);

  // Signal handler
  useEffect(() => {
    signalHandlerRef.current = (msg: SignalMessage) => {
      if (msg.job_id && msg.job_id !== jobId) return;
      if (msg.event === "stop" && ptyRef.current && !exitedRef.current) {
        try { ptyRef.current.kill(); } catch { /* ignore */ }
      }
    };
    return () => {
      signalHandlerRef.current = null;
    };
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
      if (termRef.current) {
        try { termRef.current.destroy(); } catch { /* ignore */ }
        termRef.current = null;
      }
    };
  }, []);

  useKeyboard((event: KeyEvent) => {
    if (event.name === "escape") {
      if (ptyRef.current) {
        try { ptyRef.current.kill(); } catch { /* ignore */ }
      }
      if (termRef.current) {
        try { termRef.current.destroy(); } catch { /* ignore */ }
      }
      onDone();
      event.preventDefault();
      return;
    }
    event.preventDefault();
  });

  const renderTerminal = useCallback((buffer: OptimizedBuffer) => {
    const term = termRef.current;
    if (!term) return;
    try {
      const data = term.getJson();
      renderTerminalToBuffer(buffer, data, 1, 4); // offset for header + border
    } catch {
      // terminal might be destroyed
    }
  }, []);

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
  }, [jobId, store, config, iterationStore, _tick]);

  return (
    <box width="100%" height="100%" flexDirection="column">
      {job && <PhaseHeader job={job} workflowConfig={wfConfig} iteration={iteration} />}
      <box
        flexGrow={1}
        borderStyle="single"
        borderColor={COLOR_CYAN}
        renderAfter={renderTerminal}
      />
      <StatusBar items={[
        { key: "Esc", label: "一覧に戻る" },
      ]} />
    </box>
  );
}
