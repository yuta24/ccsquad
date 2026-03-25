import type { KeyEvent, OptimizedBuffer } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { PersistentTerminal } from "ghostty-opentui";
import { spawn, type IPty } from "bun-pty";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { SquadConfig, WorkflowConfig } from "../../config.js";
import { parseTransitionCondition } from "../../config.js";
import type { Job } from "../../job.js";
import { JobStore } from "../../job.js";
import type { IterationStore } from "../../iteration.js";
import { resolveAndExecuteTransition } from "../../service/transition.js";
import { extractResult } from "../../result.js";
import { renderTerminalToBuffer } from "../terminal-render.js";
import { useSyncedState } from "../hooks/use-synced-state.js";
import { PhaseHeader } from "../components/phase-header.js";
import { StatusBar } from "../components/status-bar.js";
import type { TransitionInfo } from "../constants.js";
import {
  ATTR_BOLD, COLOR_CYAN, COLOR_GRAY, COLOR_YELLOW, COLOR_DARK_BG,
} from "../constants.js";

interface PhaseRunningViewProps {
  jobId: string;
  phase: string;
  store: JobStore;
  config: SquadConfig;
  iterationStore: IterationStore;
  onTransition: (info: TransitionInfo) => void;
  onDone: () => void;
  onQuit: () => void;
}

export function PhaseRunningView({
  jobId, phase, store, config, iterationStore,
  onTransition, onDone, onQuit,
}: PhaseRunningViewProps) {
  const [tick, setTick] = useState(0);
  const [statusMsg, setStatusMsg] = useState<string>("エージェントを起動中...");
  const [fallbackMode, setFallbackMode, fallbackModeRef] = useSyncedState(false);
  const [fallbackOptions, setFallbackOptions, fallbackOptionsRef] = useSyncedState<string[]>([]);
  const [fallbackCursor, setFallbackCursor, fallbackCursorRef] = useSyncedState(0);
  const ptyRef = useRef<IPty | null>(null);
  const termRef = useRef<PersistentTerminal | null>(null);
  const isProcessingRef = useRef(false);
  const currentPhaseRef = useRef(phase);

  const spawnAgentForPhase = useCallback((phaseName: string, term: PersistentTerminal) => {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    let jobData: Job;
    try {
      jobData = store.load(jobId);
    } catch {
      return;
    }
    const wf = config.getWorkflow(jobData.frontmatter.workflow);
    const phaseConfig = wf?.getPhase(phaseName);
    const agent = phaseConfig?.agent ?? "claude";
    const iteration = iterationStore.get(jobId);

    const promptParts = [
      `ジョブID: ${jobId}`,
      `タイトル: ${jobData.frontmatter.title}`,
      `フェーズ: ${phaseName}`,
    ];
    if (phaseConfig?.description) promptParts.push(`フェーズ説明: ${phaseConfig.description}`);
    if (jobData.body) promptParts.push(`\n説明:\n${jobData.body}`);
    promptParts.push(`\nイテレーション: ${iteration}`);

    const pty = spawn("claude", ["--agent", agent, promptParts.join("\n")], {
      name: "xterm-256color",
      cols,
      rows,
      env: { ...process.env, TERM: "xterm-256color" },
      cwd: process.cwd(),
    });
    ptyRef.current = pty;

    pty.onData((data: string) => {
      term.feed(data);
      setTick((t) => t + 1);
    });

    pty.onExit(() => {
      setStatusMsg("エージェント終了。Ctrl+D で結果を確認");
      setTick((t) => t + 1);
    });
  }, [jobId, store, config, iterationStore]);

  const processTransition = useCallback((result: string, message: string) => {
    try {
      const jobData = store.load(jobId);
      const wf = config.getWorkflow(jobData.frontmatter.workflow);
      if (!wf) {
        setStatusMsg(`ワークフロー '${jobData.frontmatter.workflow}' が見つかりません`);
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
            reason: txResult.reason === "human_review" ? undefined : txResult.reason,
          });
          break;
        case "continue": {
          const sep = `\r\n${"═".repeat(60)}\r\n フェーズ完了: ${currentPhaseRef.current} → ${txResult.nextPhase} \r\n${"═".repeat(60)}\r\n`;
          const term = termRef.current!;
          term.feed(sep);
          currentPhaseRef.current = txResult.nextPhase;
          setStatusMsg(`フェーズ ${txResult.nextPhase} を実行中...`);
          setTick((t) => t + 1);
          isProcessingRef.current = false;
          spawnAgentForPhase(txResult.nextPhase, term);
          break;
        }
      }
    } catch (e) {
      setStatusMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
      isProcessingRef.current = false;
    }
  }, [jobId, store, config, iterationStore, onTransition, onDone, spawnAgentForPhase]);

  const handleCtrlD = useCallback(() => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    ptyRef.current?.kill();
    ptyRef.current = null;

    const term = termRef.current;
    if (!term) {
      isProcessingRef.current = false;
      onDone();
      return;
    }

    let text = "";
    try { text = term.getText(); } catch { text = ""; }

    const agentResult = extractResult(text);

    if (!agentResult) {
      setStatusMsg("結果を自動検出できませんでした。手動で選択してください");
      isProcessingRef.current = false;

      try {
        const jobData = store.load(jobId);
        const wf = config.getWorkflow(jobData.frontmatter.workflow);
        const currentPhase = jobData.frontmatter.current_phase ?? currentPhaseRef.current;
        const phaseConfig = wf?.getPhase(currentPhase);
        if (phaseConfig?.reviewer !== undefined) {
          setFallbackOptions(["approved", "rejected"]);
        } else {
          setFallbackOptions(["completed", "failed"]);
        }
      } catch {
        setFallbackOptions(["completed", "failed"]);
      }
      setFallbackCursor(0);
      setFallbackMode(true);
      return;
    }

    processTransition(agentResult.result, agentResult.message);
  }, [jobId, store, config, processTransition, onDone, setFallbackMode, setFallbackOptions, setFallbackCursor]);

  useEffect(() => {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const term = new PersistentTerminal({ cols, rows });
    termRef.current = term;
    currentPhaseRef.current = phase;

    spawnAgentForPhase(phase, term);
    setStatusMsg("エージェント実行中...");

    return () => {
      ptyRef.current?.kill();
      ptyRef.current = null;
      termRef.current?.destroy();
      termRef.current = null;
    };
  }, []);

  useKeyboard((event: KeyEvent) => {
    if (fallbackModeRef.current) {
      if (event.name === "up" || event.name === "k") {
        setFallbackCursor(Math.max(0, fallbackCursorRef.current - 1));
        event.preventDefault();
        return;
      }
      if (event.name === "down" || event.name === "j") {
        setFallbackCursor(Math.min(fallbackOptionsRef.current.length - 1, fallbackCursorRef.current + 1));
        event.preventDefault();
        return;
      }
      if (event.name === "return" || event.name === "enter") {
        const selectedResult = fallbackOptionsRef.current[fallbackCursorRef.current];
        if (selectedResult) {
          setFallbackMode(false);
          processTransition(selectedResult, "手動選択");
        }
        event.preventDefault();
        return;
      }
      if (event.name === "escape") {
        setFallbackMode(false);
        onDone();
        event.preventDefault();
        return;
      }
      event.preventDefault();
      return;
    }

    if (event.ctrl && event.name === "q") { onQuit(); event.preventDefault(); return; }
    if (event.ctrl && event.name === "d") { handleCtrlD(); event.preventDefault(); return; }

    // Forward to PTY
    if (ptyRef.current) {
      if (event.sequence) { ptyRef.current.write(event.sequence); }
      else if (event.name && event.name.length === 1) { ptyRef.current.write(event.name); }
    }
    event.preventDefault();
  });

  const renderTerminal = useCallback((buffer: OptimizedBuffer) => {
    const term = termRef.current;
    if (!term) return;
    try {
      const data = term.getJson();
      renderTerminalToBuffer(buffer, data, 1, 1);
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
  }, [jobId, store, config, iterationStore, tick, statusMsg]);

  if (fallbackMode) {
    return (
      <box width="100%" height="100%" flexDirection="column">
        {job && <PhaseHeader job={job} workflowConfig={wfConfig} iteration={iteration} />}
        <box
          flexGrow={1} flexDirection="column" borderStyle="single" borderColor={COLOR_YELLOW}
          alignItems="center" justifyContent="center"
        >
          <text fg={COLOR_YELLOW} attributes={ATTR_BOLD}>結果を手動で選択してください</text>
          <box height={1} />
          {fallbackOptions.map((opt, idx) => (
            <text key={opt} fg={idx === fallbackCursor ? COLOR_CYAN : COLOR_GRAY} attributes={idx === fallbackCursor ? ATTR_BOLD : 0}>
              {idx === fallbackCursor ? "▶ " : "  "}{opt}
            </text>
          ))}
        </box>
        <box height={1} paddingLeft={1}>
          <text fg={COLOR_GRAY}>{statusMsg}</text>
        </box>
        <StatusBar items={[
          { key: "↑/k↓/j", label: "選択" }, { key: "Enter", label: "確定" }, { key: "Esc", label: "キャンセル" },
        ]} />
      </box>
    );
  }

  return (
    <box width="100%" height="100%" flexDirection="column">
      {job && <PhaseHeader job={job} workflowConfig={wfConfig} iteration={iteration} />}
      <box flexGrow={1} borderStyle="single" borderColor="#66ff66" renderAfter={renderTerminal} />
      <box height={1} paddingLeft={1} backgroundColor={COLOR_DARK_BG}>
        <text fg={COLOR_GRAY}>{statusMsg}</text>
      </box>
      <StatusBar items={[
        { key: "Ctrl+D", label: "フェーズ完了" }, { key: "Ctrl+C", label: "割り込み" }, { key: "Ctrl+Q", label: "終了" },
      ]} />
    </box>
  );
}
