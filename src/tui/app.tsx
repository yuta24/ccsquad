import { createCliRenderer, type KeyEvent, RGBA, type OptimizedBuffer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { PersistentTerminal, type TerminalData, StyleFlags } from "ghostty-opentui";
import { spawn, type IPty } from "bun-pty";
import { useState, useRef, useEffect, useCallback } from "react";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import { SquadConfigImpl } from "../config.js";
import type { SquadConfig, WorkflowConfig, PhaseConfig } from "../config.js";
import { JobStore, appendPhaseLog } from "../job.js";
import type { Job } from "../job.js";
import { WorkflowEngine } from "../engine.js";
import { IterationStore } from "../iteration.js";
import { parseTransitionCondition } from "../config.js";
import { extractResult } from "../commands/hook.js";

// --- RGBA cache for performance ---
const rgbaCache = new Map<number, RGBA>();

function getCachedRGBA(r: number, g: number, b: number): RGBA {
  const key = (r << 16) | (g << 8) | b;
  let cached = rgbaCache.get(key);
  if (!cached) {
    cached = RGBA.fromInts(r, g, b);
    rgbaCache.set(key, cached);
  }
  return cached;
}

function hexToRGBA(hex: string): RGBA {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return getCachedRGBA(r, g, b);
}

const DEFAULT_FG = getCachedRGBA(212, 212, 212); // #d4d4d4
const DEFAULT_BG = getCachedRGBA(30, 30, 30);    // #1e1e1e
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

// Attribute flags matching OpenTUI
const ATTR_BOLD = 1;
const ATTR_ITALIC = 4;
const ATTR_UNDERLINE = 8;
const ATTR_STRIKETHROUGH = 128;

// --- Render terminal data to OptimizedBuffer ---
function renderTerminalToBuffer(
  buffer: OptimizedBuffer,
  data: TerminalData,
  offsetX: number,
  offsetY: number,
) {
  for (let row = 0; row < data.lines.length; row++) {
    const line = data.lines[row];
    let col = 0;

    for (const span of line.spans) {
      let fg = span.fg ? hexToRGBA(span.fg) : DEFAULT_FG;
      let bg = span.bg ? hexToRGBA(span.bg) : TRANSPARENT;
      const flags = span.flags;

      // Handle inverse
      if (flags & StyleFlags.INVERSE) {
        const tmp = fg;
        fg = bg.buffer[3] === 0 ? DEFAULT_BG : bg;
        bg = tmp;
      }

      // Handle dim/faint
      if (flags & StyleFlags.FAINT) {
        const r = Math.floor(fg.buffer[0] * 255 * 0.5);
        const g = Math.floor(fg.buffer[1] * 255 * 0.5);
        const b = Math.floor(fg.buffer[2] * 255 * 0.5);
        fg = getCachedRGBA(r, g, b);
      }

      // Build attributes
      let attrs = 0;
      if (flags & StyleFlags.BOLD) attrs |= ATTR_BOLD;
      if (flags & StyleFlags.ITALIC) attrs |= ATTR_ITALIC;
      if (flags & StyleFlags.UNDERLINE) attrs |= ATTR_UNDERLINE;
      if (flags & StyleFlags.STRIKETHROUGH) attrs |= ATTR_STRIKETHROUGH;

      // Render each character
      for (const char of span.text) {
        buffer.setCell(offsetX + col, offsetY + row, char, fg, bg, attrs);
        col++;
      }
    }
  }

  // Render cursor
  if (data.cursorVisible) {
    const cx = data.cursor[0];
    const cy = Math.max(0, (data.totalLines - data.rows) + data.cursor[1] - data.offset);
    if (cy >= 0 && cy < data.lines.length) {
      buffer.setCell(
        offsetX + cx,
        offsetY + cy,
        " ",
        DEFAULT_BG,
        DEFAULT_FG,
        0,
      );
    }
  }
}

// --- Global renderer for cleanup ---
let rendererInstance: any = null;

function quit() {
  rendererInstance?.destroy();
  process.exit(0);
}

// --- Config/Store initialization ---
function findConfig(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, "ccsquad.yaml");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// --- Type definitions ---

interface TransitionInfo {
  prevPhase: string;
  result: string;
  message: string;
  nextPhase: string;
  description?: string;
  agent?: string;
  reviewer?: string;
  reason?: "pause" | "max_iterations";
}

type Screen =
  | { type: "normal" }
  | { type: "job-list" }
  | { type: "phase-running"; jobId: string; phase: string }
  | { type: "pause-review"; jobId: string; phase: string; info: TransitionInfo }
  | { type: "job-create" };

// --- Shared utility ---

function truncateStr(s: string, maxLen: number): string {
  if ([...s].length <= maxLen) return s;
  return [...s].slice(0, maxLen - 2).join("") + "..";
}

function padRight(s: string, len: number): string {
  const chars = [...s];
  if (chars.length >= len) return chars.slice(0, len).join("");
  return s + " ".repeat(len - chars.length);
}

// Color constants (hex strings for OpenTUI)
const COLOR_WHITE = "#ffffff";
const COLOR_GRAY = "#888888";
const COLOR_CYAN = "#00ffff";
const COLOR_YELLOW = "#ffff00";
const COLOR_GREEN = "#00ff00";
const COLOR_RED = "#ff4444";
const COLOR_DARK_RED = "#8b0000";
const COLOR_DARK_GRAY = "#555555";
const COLOR_SELECTED_BG = "#2d4a6e";
const COLOR_HEADER_BG = "#1a1a2e";
const COLOR_WARN_BG = "#5a0000";
const COLOR_SUCCESS_BG = "#1a3a1a";
const COLOR_DARK_BG = "#1a1a1a";
const COLOR_COL_HEADER_BG = "#252525";

// --- WorkflowDiagram component ---
interface WorkflowDiagramProps {
  phases: PhaseConfig[];
  currentPhase?: string;
}

function WorkflowDiagram({ phases, currentPhase }: WorkflowDiagramProps) {
  if (phases.length === 0) {
    return <text fg={COLOR_GRAY}>ワークフロー定義なし</text>;
  }

  const parts: string[] = [];
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const isCurrent = phase.name === currentPhase;
    parts.push(`${isCurrent ? "●" : "○"} ${phase.name}`);
    if (i < phases.length - 1) {
      parts.push(" ─→ ");
    }
  }

  // Build a simple text representation
  const diagText = phases.map((p, i) => {
    const isCurrent = p.name === currentPhase;
    const marker = isCurrent ? "●" : "○";
    const arrow = i < phases.length - 1 ? " ─→ " : "";
    return `${marker} ${p.name}${arrow}`;
  }).join("");

  return <text fg={COLOR_GRAY}>{diagText}</text>;
}

// --- StatusBar component ---
interface StatusBarItem {
  key: string;
  label: string;
}

interface StatusBarProps {
  items: StatusBarItem[];
}

function StatusBar({ items }: StatusBarProps) {
  const content = items.map((item) => ` [${item.key}] ${item.label} `).join("");
  return (
    <box
      width="100%"
      height={1}
      backgroundColor="#333333"
    >
      <text fg={COLOR_YELLOW}>{content}</text>
    </box>
  );
}

// --- PhaseHeader component ---
interface PhaseHeaderProps {
  job: Job;
  workflowConfig: WorkflowConfig | undefined;
  iteration: number;
}

function PhaseHeader({ job, workflowConfig, iteration }: PhaseHeaderProps) {
  const fm = job.frontmatter;
  const phases = workflowConfig?.phases ?? [];

  const titleLine = `${fm.id} | ${truncateStr(fm.title, 40)} | ワークフロー: ${fm.workflow} | イテレーション: ${iteration}`;
  const diagText = phases.map((p, i) => {
    const isCurrent = p.name === fm.current_phase;
    const marker = isCurrent ? "●" : "○";
    const arrow = i < phases.length - 1 ? " ─→ " : "";
    return `${marker} ${p.name}${arrow}`;
  }).join("");

  return (
    <box
      width="100%"
      borderStyle="single"
      borderColor={COLOR_CYAN}
    >
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <text fg={COLOR_CYAN} attributes={ATTR_BOLD}>{titleLine}</text>
        <text fg={COLOR_GRAY}>{diagText || "フェーズなし"}</text>
      </box>
    </box>
  );
}

// --- NormalMode (Claude terminal) ---
interface NormalModeProps {
  onSwitchToWorkflow: () => void;
  onQuit: () => void;
}

function NormalMode({ onSwitchToWorkflow, onQuit }: NormalModeProps) {
  const [_, setTick] = useState(0);
  const ptyRef = useRef<IPty | null>(null);
  const termRef = useRef<PersistentTerminal | null>(null);

  useEffect(() => {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const term = new PersistentTerminal({ cols, rows });
    termRef.current = term;

    const pty = spawn("claude", [], {
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
      setTick((t) => t + 1);
    });

    return () => {
      pty.kill();
      term.destroy();
      ptyRef.current = null;
      termRef.current = null;
    };
  }, []);

  useKeyboard((event: KeyEvent) => {
    if (event.ctrl && event.name === "q") {
      ptyRef.current?.kill();
      termRef.current?.destroy();
      onQuit();
      event.preventDefault();
      return;
    }

    if (event.ctrl && event.name === "s") {
      ptyRef.current?.kill();
      termRef.current?.destroy();
      onSwitchToWorkflow();
      event.preventDefault();
      return;
    }

    // Forward to PTY
    if (ptyRef.current) {
      if (event.sequence) {
        ptyRef.current.write(event.sequence);
      } else if (event.name && event.name.length === 1) {
        ptyRef.current.write(event.name);
      }
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

  return (
    <box
      width="100%"
      height="100%"
      borderStyle="single"
      borderColor="#66ff66"
      title=" SQUAD | Ctrl+S: Workflow  Ctrl+Q: Quit "
      titleColor="cyan"
      renderAfter={renderTerminal}
    />
  );
}

// --- JobListView ---
interface JobListViewProps {
  store: JobStore;
  config: SquadConfig;
  iterationStore: IterationStore;
  onStartJob: (jobId: string, phase: string) => void;
  onResumeJob: (job: Job, workflowConfig: WorkflowConfig) => void;
  onCreateJob: () => void;
  onSwitchToNormal: () => void;
  onQuit: () => void;
}

function JobListView({
  store,
  config,
  iterationStore,
  onStartJob,
  onResumeJob,
  onCreateJob,
  onSwitchToNormal,
  onQuit,
}: JobListViewProps) {
  const [cursor, setCursor] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [confirmAction, setConfirmAction] = useState<{ type: "delete" | "abort"; jobId: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const cursorRef = useRef(0);
  const jobsRef = useRef<Job[]>([]);
  const confirmRef = useRef<{ type: "delete" | "abort"; jobId: string } | null>(null);

  useEffect(() => {
    confirmRef.current = confirmAction;
  }, [confirmAction]);

  const loadJobs = useCallback(() => {
    try {
      const loaded = store.listAll();
      setJobs(loaded);
      jobsRef.current = loaded;
    } catch {
      setJobs([]);
      jobsRef.current = [];
    }
  }, [store]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  const statusColor = (status: string): string => {
    switch (status) {
      case "pending": return COLOR_GRAY;
      case "running": return COLOR_YELLOW;
      case "completed": return COLOR_GREEN;
      case "failed": return COLOR_RED;
      case "aborted": return COLOR_DARK_RED;
      case "closed": return COLOR_DARK_GRAY;
      default: return COLOR_WHITE;
    }
  };

  const selectedJob = jobs[cursor];
  const selectedWorkflow = selectedJob
    ? config.getWorkflow(selectedJob.frontmatter.workflow)
    : undefined;

  useKeyboard((event: KeyEvent) => {
    if (confirmRef.current) {
      if (event.name === "y" || event.name === "Y") {
        const { type, jobId } = confirmRef.current;
        setConfirmAction(null);
        confirmRef.current = null;
        try {
          if (type === "delete") {
            store.delete(jobId);
            setMessage(`ジョブ ${jobId} を削除しました`);
          } else if (type === "abort") {
            const job = store.load(jobId);
            const wf = config.getWorkflow(job.frontmatter.workflow);
            if (wf) {
              const engine = new WorkflowEngine(wf, store);
              engine.abortJob(jobId);
            }
            setMessage(`ジョブ ${jobId} を中断しました`);
          }
          loadJobs();
          const newCursor = Math.min(cursorRef.current, Math.max(0, jobsRef.current.length - 2));
          setCursor(newCursor);
          cursorRef.current = newCursor;
        } catch (e) {
          setMessage(`エラー: ${e instanceof Error ? e.message : String(e)}`);
        }
        event.preventDefault();
        return;
      }
      if (event.name === "n" || event.name === "N" || event.name === "escape") {
        setConfirmAction(null);
        confirmRef.current = null;
        event.preventDefault();
        return;
      }
      event.preventDefault();
      return;
    }

    if (event.ctrl && event.name === "q") {
      onQuit();
      event.preventDefault();
      return;
    }

    if (event.ctrl && event.name === "s") {
      onSwitchToNormal();
      event.preventDefault();
      return;
    }

    if (event.name === "up" || event.name === "k") {
      const newCursor = Math.max(0, cursorRef.current - 1);
      setCursor(newCursor);
      cursorRef.current = newCursor;
      setMessage(null);
      event.preventDefault();
      return;
    }
    if (event.name === "down" || event.name === "j") {
      const newCursor = Math.min(jobsRef.current.length - 1, cursorRef.current + 1);
      setCursor(newCursor);
      cursorRef.current = newCursor;
      setMessage(null);
      event.preventDefault();
      return;
    }

    if (event.name === "return" || event.name === "enter") {
      const job = jobsRef.current[cursorRef.current];
      if (!job) {
        event.preventDefault();
        return;
      }
      const fm = job.frontmatter;
      if (fm.status === "pending") {
        try {
          const wf = config.getWorkflow(fm.workflow);
          if (!wf) {
            setMessage(`ワークフロー '${fm.workflow}' が見つかりません`);
            event.preventDefault();
            return;
          }
          const engine = new WorkflowEngine(wf, store);
          const startedJob = engine.startJob(fm.id);
          const phase = startedJob.frontmatter.current_phase ?? wf.initialPhase().name;
          onStartJob(fm.id, phase);
        } catch (e) {
          setMessage(`エラー: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (fm.status === "running") {
        const wf = config.getWorkflow(fm.workflow);
        if (wf) {
          onResumeJob(job, wf);
        } else {
          setMessage(`ワークフロー '${fm.workflow}' が見つかりません`);
        }
      } else {
        setMessage(`ステータス '${fm.status}' のジョブは開始できません`);
      }
      event.preventDefault();
      return;
    }

    if (event.name === "n") {
      onCreateJob();
      event.preventDefault();
      return;
    }

    if (event.name === "d") {
      const job = jobsRef.current[cursorRef.current];
      if (job) {
        const action = { type: "delete" as const, jobId: job.frontmatter.id };
        setConfirmAction(action);
        confirmRef.current = action;
        setMessage(null);
      }
      event.preventDefault();
      return;
    }

    if (event.name === "a") {
      const job = jobsRef.current[cursorRef.current];
      if (job && (job.frontmatter.status === "running" || job.frontmatter.status === "pending")) {
        const action = { type: "abort" as const, jobId: job.frontmatter.id };
        setConfirmAction(action);
        confirmRef.current = action;
        setMessage(null);
      } else {
        setMessage("中断できるジョブがありません");
      }
      event.preventDefault();
      return;
    }

    if (event.name === "r") {
      loadJobs();
      setMessage("ジョブ一覧を更新しました");
      event.preventDefault();
      return;
    }
  });

  // Build job table rows
  const headerLine = `${padRight("ID", 10)} ${padRight("タイトル", 28)} ${padRight("ワークフロー", 12)} ${padRight("ステータス", 12)} ${padRight("フェーズ", 15)} ${padRight("優先度", 4)}`;

  return (
    <box width="100%" height="100%" flexDirection="column">
      {/* Header */}
      <box
        width="100%"
        height={1}
        backgroundColor={COLOR_HEADER_BG}
      >
        <text fg={COLOR_CYAN} attributes={ATTR_BOLD}> CCSQUAD - ジョブ管理 </text>
      </box>

      {/* Job list */}
      <box flexDirection="column" width="100%" flexGrow={1} borderStyle="single" borderColor={COLOR_GRAY}>
        {/* Column headers */}
        <box height={1} backgroundColor={COLOR_COL_HEADER_BG} paddingLeft={1}>
          <text fg={COLOR_GRAY}>{headerLine}</text>
        </box>

        {jobs.length === 0 ? (
          <box alignItems="center" justifyContent="center" flexGrow={1}>
            <text fg={COLOR_GRAY}>ジョブがありません。n キーで新規作成</text>
          </box>
        ) : (
          jobs.map((job, idx) => {
            const fm = job.frontmatter;
            const isSelected = idx === cursor;
            const id = padRight(fm.id, 10);
            const title = padRight(truncateStr(fm.title, 26), 28);
            const wf = padRight(truncateStr(fm.workflow, 10), 12);
            const status = padRight(fm.status, 12);
            const phase = padRight(fm.current_phase ?? "-", 15);
            const pri = padRight(String(fm.priority), 4);
            const line = `${id} ${title} ${wf} ${status} ${phase} ${pri}`;
            return (
              <box
                key={fm.id}
                height={1}
                paddingLeft={1}
                backgroundColor={isSelected ? COLOR_SELECTED_BG : undefined}
              >
                <text
                  fg={isSelected ? COLOR_WHITE : statusColor(fm.status)}
                  attributes={isSelected ? ATTR_BOLD : 0}
                >
                  {line}
                </text>
              </box>
            );
          })
        )}
      </box>

      {/* Workflow diagram for selected job */}
      {selectedJob && selectedWorkflow && (
        <box
          flexDirection="column"
          width="100%"
          borderStyle="single"
          borderColor={COLOR_GRAY}
          height={4}
        >
          <box height={1} paddingLeft={1}>
            <text fg={COLOR_GRAY} attributes={ATTR_BOLD}>ワークフロー: </text>
            <text fg={COLOR_YELLOW}>{selectedJob.frontmatter.workflow}</text>
          </box>
          <box height={1} paddingLeft={1}>
            <WorkflowDiagram
              phases={selectedWorkflow.phases}
              currentPhase={selectedJob.frontmatter.current_phase}
            />
          </box>
        </box>
      )}

      {/* Confirm dialog */}
      {confirmAction && (
        <box
          height={1}
          backgroundColor={COLOR_WARN_BG}
          paddingLeft={1}
        >
          <text fg={COLOR_WHITE}>
            {confirmAction.type === "delete"
              ? `ジョブ ${confirmAction.jobId} を削除しますか？ [y/n]`
              : `ジョブ ${confirmAction.jobId} を中断しますか？ [y/n]`}
          </text>
        </box>
      )}

      {/* Message area */}
      {message && !confirmAction && (
        <box height={1} paddingLeft={1} backgroundColor={COLOR_SUCCESS_BG}>
          <text fg={COLOR_GREEN}>{message}</text>
        </box>
      )}

      {/* Status bar */}
      <StatusBar items={[
        { key: "↑/k", label: "上" },
        { key: "↓/j", label: "下" },
        { key: "Enter", label: "開始/再開" },
        { key: "n", label: "新規作成" },
        { key: "d", label: "削除" },
        { key: "a", label: "中断" },
        { key: "r", label: "更新" },
        { key: "Ctrl+S", label: "Normal" },
        { key: "Ctrl+Q", label: "終了" },
      ]} />
    </box>
  );
}

// --- PhaseRunningView ---
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

function PhaseRunningView({
  jobId,
  phase,
  store,
  config,
  iterationStore,
  onTransition,
  onDone,
  onQuit,
}: PhaseRunningViewProps) {
  const [tick, setTick] = useState(0);
  const [statusMsg, setStatusMsg] = useState<string>("エージェントを起動中...");
  const [fallbackMode, setFallbackMode] = useState(false);
  const [fallbackOptions, setFallbackOptions] = useState<string[]>([]);
  const [fallbackCursor, setFallbackCursor] = useState(0);
  const ptyRef = useRef<IPty | null>(null);
  const termRef = useRef<PersistentTerminal | null>(null);
  const fallbackModeRef = useRef(false);
  const fallbackCursorRef = useRef(0);
  const fallbackOptionsRef = useRef<string[]>([]);
  const isProcessingRef = useRef(false);
  const currentPhaseRef = useRef(phase);

  useEffect(() => {
    fallbackModeRef.current = fallbackMode;
  }, [fallbackMode]);

  useEffect(() => {
    fallbackCursorRef.current = fallbackCursor;
  }, [fallbackCursor]);

  useEffect(() => {
    fallbackOptionsRef.current = fallbackOptions;
  }, [fallbackOptions]);

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

    // Build prompt
    const promptParts = [
      `ジョブID: ${jobId}`,
      `タイトル: ${jobData.frontmatter.title}`,
      `フェーズ: ${phaseName}`,
    ];
    if (phaseConfig?.description) {
      promptParts.push(`フェーズ説明: ${phaseConfig.description}`);
    }
    if (jobData.body) {
      promptParts.push(`\n説明:\n${jobData.body}`);
    }
    promptParts.push(`\nイテレーション: ${iteration}`);
    const prompt = promptParts.join("\n");

    const pty = spawn("claude", ["--agent", agent, prompt], {
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

      const currentPhase = jobData.frontmatter.current_phase ?? currentPhaseRef.current;
      const phaseConfig = wf.getPhase(currentPhase);
      if (!phaseConfig) {
        setStatusMsg(`フェーズ '${currentPhase}' が見つかりません`);
        isProcessingRef.current = false;
        return;
      }

      const condition = parseTransitionCondition(result);
      const next = wf.resolveTransition(currentPhase, condition);

      if (next === "COMPLETE" || next === "ABORT") {
        // Terminal transition
        const engine = new WorkflowEngine(wf, store);
        if (phaseConfig.reviewer !== undefined) {
          if (condition === "approved") {
            engine.approve(jobId, message);
          } else {
            engine.reject(jobId, message);
          }
        } else {
          engine.transition(jobId, condition, message);
        }
        iterationStore.remove(jobId);
        isProcessingRef.current = false;
        onDone();
        return;
      }

      const nextPhase = wf.getPhase(next);
      if (!nextPhase) {
        setStatusMsg(`遷移先フェーズ '${next}' が見つかりません`);
        isProcessingRef.current = false;
        return;
      }

      if (nextPhase.pause) {
        // Pause: record log, go to PauseReview
        const jobToUpdate = store.load(jobId);
        appendPhaseLog(jobToUpdate, currentPhase, condition, next, message);
        jobToUpdate.frontmatter.updated_at = new Date().toISOString();
        store.save(jobToUpdate);
        isProcessingRef.current = false;
        onTransition({
          prevPhase: currentPhase,
          result: condition,
          message,
          nextPhase: next,
          description: nextPhase.description,
          agent: nextPhase.agent,
          reviewer: nextPhase.reviewer,
          reason: "pause",
        });
        return;
      }

      const currentIteration = iterationStore.get(jobId);
      if (currentIteration >= wf.maxIterations()) {
        // Max iterations: record log, go to PauseReview
        const jobToUpdate = store.load(jobId);
        appendPhaseLog(jobToUpdate, currentPhase, condition, next, message);
        jobToUpdate.frontmatter.updated_at = new Date().toISOString();
        store.save(jobToUpdate);
        isProcessingRef.current = false;
        onTransition({
          prevPhase: currentPhase,
          result: condition,
          message,
          nextPhase: next,
          description: nextPhase.description,
          agent: nextPhase.agent,
          reviewer: nextPhase.reviewer,
          reason: "max_iterations",
        });
        return;
      }

      // If reviewer: "human" next phase, go to PauseReview
      if (nextPhase.reviewer === "human") {
        const engine = new WorkflowEngine(wf, store);
        if (phaseConfig.reviewer !== undefined) {
          if (condition === "approved") {
            engine.approve(jobId, message);
          } else {
            engine.reject(jobId, message);
          }
        } else {
          engine.transition(jobId, condition, message);
        }
        iterationStore.increment(jobId);
        isProcessingRef.current = false;
        onTransition({
          prevPhase: currentPhase,
          result: condition,
          message,
          nextPhase: next,
          description: nextPhase.description,
          agent: nextPhase.agent,
          reviewer: nextPhase.reviewer,
        });
        return;
      }

      // Auto-transition: execute and continue in PhaseRunning
      const engine = new WorkflowEngine(wf, store);
      if (phaseConfig.reviewer !== undefined) {
        if (condition === "approved") {
          engine.approve(jobId, message);
        } else {
          engine.reject(jobId, message);
        }
      } else {
        engine.transition(jobId, condition, message);
      }
      iterationStore.increment(jobId);

      // Feed separator to terminal
      const sep = `\r\n${"═".repeat(60)}\r\n フェーズ完了: ${currentPhase} → ${next} \r\n${"═".repeat(60)}\r\n`;
      const term = termRef.current!;
      term.feed(sep);
      currentPhaseRef.current = next;
      setStatusMsg(`フェーズ ${next} を実行中...`);
      setTick((t) => t + 1);
      isProcessingRef.current = false;

      // Spawn next phase in same terminal
      spawnAgentForPhase(next, term);
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
    try {
      text = term.getText();
    } catch {
      text = "";
    }

    const agentResult = extractResult(text);

    if (!agentResult) {
      // Fallback: manual selection
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

    // Process transition
    processTransition(agentResult.result, agentResult.message);
  }, [jobId, store, config, processTransition, onDone]);

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
        const newCursor = Math.max(0, fallbackCursorRef.current - 1);
        setFallbackCursor(newCursor);
        fallbackCursorRef.current = newCursor;
        event.preventDefault();
        return;
      }
      if (event.name === "down" || event.name === "j") {
        const newCursor = Math.min(fallbackOptionsRef.current.length - 1, fallbackCursorRef.current + 1);
        setFallbackCursor(newCursor);
        fallbackCursorRef.current = newCursor;
        event.preventDefault();
        return;
      }
      if (event.name === "return" || event.name === "enter") {
        const selectedResult = fallbackOptionsRef.current[fallbackCursorRef.current];
        if (selectedResult) {
          setFallbackMode(false);
          fallbackModeRef.current = false;
          processTransition(selectedResult, "手動選択");
        }
        event.preventDefault();
        return;
      }
      if (event.name === "escape") {
        setFallbackMode(false);
        fallbackModeRef.current = false;
        onDone();
        event.preventDefault();
        return;
      }
      event.preventDefault();
      return;
    }

    if (event.ctrl && event.name === "q") {
      onQuit();
      event.preventDefault();
      return;
    }

    if (event.ctrl && event.name === "d") {
      handleCtrlD();
      event.preventDefault();
      return;
    }

    // Forward to PTY
    if (ptyRef.current) {
      if (event.sequence) {
        ptyRef.current.write(event.sequence);
      } else if (event.name && event.name.length === 1) {
        ptyRef.current.write(event.name);
      }
    }
    event.preventDefault();
  });

  // Render terminal
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

  if (fallbackMode) {
    return (
      <box width="100%" height="100%" flexDirection="column">
        {job && <PhaseHeader job={job} workflowConfig={wfConfig} iteration={iteration} />}
        <box
          flexGrow={1}
          flexDirection="column"
          borderStyle="single"
          borderColor={COLOR_YELLOW}
          alignItems="center"
          justifyContent="center"
        >
          <text fg={COLOR_YELLOW} attributes={ATTR_BOLD}>結果を手動で選択してください</text>
          <box height={1} />
          {fallbackOptions.map((opt, idx) => (
            <text
              key={opt}
              fg={idx === fallbackCursor ? COLOR_CYAN : COLOR_GRAY}
              attributes={idx === fallbackCursor ? ATTR_BOLD : 0}
            >
              {idx === fallbackCursor ? "▶ " : "  "}{opt}
            </text>
          ))}
        </box>
        <box height={1} paddingLeft={1}>
          <text fg={COLOR_GRAY}>{statusMsg}</text>
        </box>
        <StatusBar items={[
          { key: "↑/k↓/j", label: "選択" },
          { key: "Enter", label: "確定" },
          { key: "Esc", label: "キャンセル" },
        ]} />
      </box>
    );
  }

  return (
    <box width="100%" height="100%" flexDirection="column">
      {job && <PhaseHeader job={job} workflowConfig={wfConfig} iteration={iteration} />}
      <box
        flexGrow={1}
        borderStyle="single"
        borderColor="#66ff66"
        renderAfter={renderTerminal}
      />
      <box height={1} paddingLeft={1} backgroundColor={COLOR_DARK_BG}>
        <text fg={COLOR_GRAY}>{statusMsg}</text>
      </box>
      <StatusBar items={[
        { key: "Ctrl+D", label: "フェーズ完了" },
        { key: "Ctrl+C", label: "割り込み" },
        { key: "Ctrl+Q", label: "終了" },
      ]} />
    </box>
  );
}

// --- PauseReviewView ---
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

function PauseReviewView({
  jobId,
  phase,
  info,
  store,
  config,
  iterationStore,
  onRunAgent,
  onDone,
  onQuit,
}: PauseReviewViewProps) {
  const [statusMsg, setStatusMsg] = useState<string>("");

  const executeApprove = useCallback(() => {
    try {
      const jobData = store.load(jobId);
      const wf = config.getWorkflow(jobData.frontmatter.workflow);
      if (!wf) {
        setStatusMsg("ワークフローが見つかりません");
        return;
      }

      const currentPhase = jobData.frontmatter.current_phase ?? phase;
      const phaseConfig = wf.getPhase(currentPhase);

      if (!phaseConfig) {
        setStatusMsg(`フェーズ '${currentPhase}' が見つかりません`);
        return;
      }

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
      if (!wf) {
        setStatusMsg("ワークフローが見つかりません");
        return;
      }

      const currentPhase = jobData.frontmatter.current_phase ?? phase;
      const phaseConfig = wf.getPhase(currentPhase);

      if (!phaseConfig) {
        setStatusMsg(`フェーズ '${currentPhase}' が見つかりません`);
        return;
      }

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
    if (event.ctrl && event.name === "q") {
      onQuit();
      event.preventDefault();
      return;
    }

    if (event.name === "escape") {
      onDone();
      event.preventDefault();
      return;
    }

    const isHumanReviewer = info.reviewer === "human";
    const isAgentReviewer = info.reviewer && info.reviewer !== "human";
    const isPauseOnly = !info.reviewer;

    if (isHumanReviewer) {
      if (event.name === "a") {
        executeApprove();
        event.preventDefault();
        return;
      }
      if (event.name === "x") {
        executeReject();
        event.preventDefault();
        return;
      }
    } else if (isAgentReviewer) {
      if (event.name === "r" || event.name === "return" || event.name === "enter") {
        // Run reviewer agent - transition first if needed
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
      if (event.name === "a") {
        executeApprove();
        event.preventDefault();
        return;
      }
      if (event.name === "x") {
        executeReject();
        event.preventDefault();
        return;
      }
    } else if (isPauseOnly) {
      if (event.name === "return" || event.name === "enter") {
        // Run next phase agent - transition first
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
      { key: "a", label: "承認" },
      { key: "x", label: "却下" },
      { key: "Esc", label: "一覧へ戻る" },
      { key: "Ctrl+Q", label: "終了" },
    ];
  } else if (isAgentReviewer) {
    keybinds = [
      { key: "r/Enter", label: "レビューエージェント実行" },
      { key: "a", label: "直接承認" },
      { key: "x", label: "直接却下" },
      { key: "Esc", label: "一覧へ戻る" },
      { key: "Ctrl+Q", label: "終了" },
    ];
  } else {
    keybinds = [
      { key: "Enter", label: "エージェント実行" },
      { key: "Esc", label: "一覧へ戻る" },
      { key: "Ctrl+Q", label: "終了" },
    ];
  }

  const reasonLabel = info.reason === "pause"
    ? "一時停止"
    : info.reason === "max_iterations"
    ? "イテレーション上限到達"
    : "レビュー待ち";

  const resultColor = info.result === "completed" || info.result === "approved" ? COLOR_GREEN : COLOR_RED;
  const reviewerColor = info.reviewer === "human" ? COLOR_CYAN : COLOR_GREEN;

  return (
    <box width="100%" height="100%" flexDirection="column">
      {job && <PhaseHeader job={job} workflowConfig={wfConfig} iteration={iteration} />}

      <box
        flexGrow={1}
        flexDirection="column"
        borderStyle="single"
        borderColor={COLOR_YELLOW}
        padding={1}
      >
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
          {info.description ? (
            <text fg={COLOR_GRAY}>説明: <text fg={COLOR_WHITE}>{info.description}</text></text>
          ) : null}
          {info.agent ? (
            <text fg={COLOR_GRAY}>エージェント: <text fg={COLOR_GREEN}>{info.agent}</text></text>
          ) : null}
          {info.reviewer ? (
            <text fg={COLOR_GRAY}>レビュアー: <text fg={reviewerColor}>{info.reviewer}</text></text>
          ) : null}
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

// --- JobCreateView ---
interface JobCreateViewProps {
  config: SquadConfig;
  store: JobStore;
  onCreated: () => void;
  onCancel: () => void;
  onQuit: () => void;
}

function JobCreateView({ config, store, onCreated, onCancel, onQuit }: JobCreateViewProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const [title, setTitle] = useState("");
  const [workflowIndex, setWorkflowIndex] = useState(0);
  const [priority, setPriority] = useState("0");
  const [description, setDescription] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const focusRef = useRef(0);
  const titleRef = useRef("");
  const workflowIndexRef = useRef(0);
  const priorityRef = useRef("0");
  const descriptionRef = useRef("");
  const FIELD_COUNT = 4;

  useEffect(() => {
    focusRef.current = focusIndex;
  }, [focusIndex]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    workflowIndexRef.current = workflowIndex;
  }, [workflowIndex]);

  useEffect(() => {
    priorityRef.current = priority;
  }, [priority]);

  useEffect(() => {
    descriptionRef.current = description;
  }, [description]);

  const workflowNames = Object.keys(config.workflows);

  const handleCreate = useCallback(() => {
    const t = titleRef.current.trim();
    if (!t) {
      setErrorMsg("タイトルは必須です");
      return;
    }
    const wfName = workflowNames[workflowIndexRef.current];
    if (!wfName) {
      setErrorMsg("ワークフローを選択してください");
      return;
    }
    const pri = parseInt(priorityRef.current, 10) || 0;
    const desc = descriptionRef.current.trim();

    try {
      const id = store.nextId();
      const now = new Date().toISOString();
      const body = desc ? `## 説明\n${desc}\n` : "";
      store.save({
        frontmatter: {
          id,
          title: t,
          workflow: wfName,
          status: "pending",
          current_phase: undefined,
          priority: pri,
          depends_on: [],
          created_at: now,
          updated_at: now,
        },
        body,
      });
      onCreated();
    } catch (e) {
      setErrorMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [store, workflowNames, onCreated]);

  useKeyboard((event: KeyEvent) => {
    if (event.ctrl && event.name === "q") {
      onQuit();
      event.preventDefault();
      return;
    }

    if (event.name === "escape") {
      onCancel();
      event.preventDefault();
      return;
    }

    // Tab / Shift+Tab: move focus
    if (event.name === "tab") {
      const newFocus = event.shift
        ? Math.max(0, focusRef.current - 1)
        : Math.min(FIELD_COUNT - 1, focusRef.current + 1);
      setFocusIndex(newFocus);
      focusRef.current = newFocus;
      event.preventDefault();
      return;
    }

    const fi = focusRef.current;

    // Ctrl+Enter anywhere to submit
    if (event.ctrl && (event.name === "return" || event.name === "enter")) {
      handleCreate();
      event.preventDefault();
      return;
    }

    // Title field (focus 0)
    if (fi === 0) {
      if (event.name === "backspace" || event.name === "delete") {
        setTitle((prev) => {
          const next = [...prev].slice(0, -1).join("");
          titleRef.current = next;
          return next;
        });
        event.preventDefault();
        return;
      }
      if (event.name === "return" || event.name === "enter") {
        setFocusIndex(1);
        focusRef.current = 1;
        event.preventDefault();
        return;
      }
      if (!event.ctrl && !event.meta && event.sequence && event.sequence.length === 1) {
        setTitle((prev) => {
          const next = prev + event.sequence;
          titleRef.current = next;
          return next;
        });
        event.preventDefault();
        return;
      }
    }

    // Workflow select (focus 1)
    if (fi === 1) {
      if (event.name === "up" || event.name === "k") {
        const newIdx = Math.max(0, workflowIndexRef.current - 1);
        setWorkflowIndex(newIdx);
        workflowIndexRef.current = newIdx;
        event.preventDefault();
        return;
      }
      if (event.name === "down" || event.name === "j") {
        const newIdx = Math.min(workflowNames.length - 1, workflowIndexRef.current + 1);
        setWorkflowIndex(newIdx);
        workflowIndexRef.current = newIdx;
        event.preventDefault();
        return;
      }
      if (event.name === "return" || event.name === "enter") {
        setFocusIndex(2);
        focusRef.current = 2;
        event.preventDefault();
        return;
      }
    }

    // Priority field (focus 2)
    if (fi === 2) {
      if (event.name === "backspace" || event.name === "delete") {
        setPriority((prev) => {
          const next = [...prev].slice(0, -1).join("");
          priorityRef.current = next;
          return next;
        });
        event.preventDefault();
        return;
      }
      if (event.name === "return" || event.name === "enter") {
        setFocusIndex(3);
        focusRef.current = 3;
        event.preventDefault();
        return;
      }
      if (!event.ctrl && !event.meta && event.sequence && /^[0-9\-]$/.test(event.sequence)) {
        setPriority((prev) => {
          const next = prev + event.sequence;
          priorityRef.current = next;
          return next;
        });
        event.preventDefault();
        return;
      }
    }

    // Description textarea (focus 3)
    if (fi === 3) {
      if (event.name === "backspace" || event.name === "delete") {
        setDescription((prev) => {
          const next = [...prev].slice(0, -1).join("");
          descriptionRef.current = next;
          return next;
        });
        event.preventDefault();
        return;
      }
      if (event.name === "return" || event.name === "enter") {
        setDescription((prev) => {
          const next = prev + "\n";
          descriptionRef.current = next;
          return next;
        });
        event.preventDefault();
        return;
      }
      if (!event.ctrl && !event.meta && event.sequence && event.sequence.length === 1) {
        setDescription((prev) => {
          const next = prev + event.sequence;
          descriptionRef.current = next;
          return next;
        });
        event.preventDefault();
        return;
      }
    }

    event.preventDefault();
  });

  const fieldBorderColor = (idx: number) => focusIndex === idx ? COLOR_CYAN : COLOR_GRAY;
  const fieldLabelColor = (idx: number) => focusIndex === idx ? COLOR_CYAN : COLOR_GRAY;

  return (
    <box width="100%" height="100%" flexDirection="column">
      {/* Header */}
      <box height={1} backgroundColor={COLOR_HEADER_BG}>
        <text fg={COLOR_CYAN} attributes={ATTR_BOLD}> ジョブ作成 </text>
      </box>

      <box flexGrow={1} flexDirection="column" padding={1}>
        {/* Title */}
        <box flexDirection="column" marginBottom={1}>
          <text fg={fieldLabelColor(0)}>タイトル (必須):</text>
          <box
            borderStyle="single"
            borderColor={fieldBorderColor(0)}
            height={3}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={COLOR_WHITE}>{title}{focusIndex === 0 ? "█" : ""}</text>
          </box>
        </box>

        {/* Workflow */}
        <box flexDirection="column" marginBottom={1}>
          <text fg={fieldLabelColor(1)}>ワークフロー (必須):</text>
          <box
            borderStyle="single"
            borderColor={fieldBorderColor(1)}
            padding={1}
          >
            {workflowNames.length === 0 ? (
              <text fg={COLOR_RED}>ワークフローが定義されていません</text>
            ) : (
              workflowNames.map((wfName, idx) => (
                <text
                  key={wfName}
                  fg={idx === workflowIndex ? COLOR_CYAN : COLOR_GRAY}
                  attributes={idx === workflowIndex ? ATTR_BOLD : 0}
                >
                  {idx === workflowIndex ? "▶ " : "  "}{wfName}
                </text>
              ))
            )}
          </box>
        </box>

        {/* Priority */}
        <box flexDirection="column" marginBottom={1}>
          <text fg={fieldLabelColor(2)}>優先度 (デフォルト: 0):</text>
          <box
            borderStyle="single"
            borderColor={fieldBorderColor(2)}
            height={3}
            paddingLeft={1}
          >
            <text fg={COLOR_WHITE}>{priority}{focusIndex === 2 ? "█" : ""}</text>
          </box>
        </box>

        {/* Description */}
        <box flexDirection="column" flexGrow={1}>
          <text fg={fieldLabelColor(3)}>説明 (任意、Ctrl+Enter で確定):</text>
          <box
            borderStyle="single"
            borderColor={fieldBorderColor(3)}
            flexGrow={1}
            paddingLeft={1}
          >
            <text fg={COLOR_WHITE}>
              {description}{focusIndex === 3 ? "█" : ""}
            </text>
          </box>
        </box>

        {errorMsg ? (
          <box height={1} paddingLeft={1}>
            <text fg={COLOR_RED}>{errorMsg}</text>
          </box>
        ) : null}
      </box>

      <StatusBar items={[
        { key: "Tab", label: "次フィールド" },
        { key: "Shift+Tab", label: "前フィールド" },
        { key: "Ctrl+Enter", label: "作成" },
        { key: "Esc", label: "キャンセル" },
        { key: "Ctrl+Q", label: "終了" },
      ]} />
    </box>
  );
}

// --- Main App ---
function App() {
  const [screen, setScreen] = useState<Screen>({ type: "normal" });

  // Initialize stores
  const configPath = findConfig();
  let squadConfig: SquadConfig | null = null;
  let jobStore: JobStore | null = null;
  let iterationStore: IterationStore | null = null;
  let squadDir = "";
  let jobsDir = "";

  if (configPath) {
    try {
      squadConfig = SquadConfigImpl.load(configPath);
      const projectRoot = dirname(configPath);
      squadDir = join(projectRoot, ".ccsquad");
      jobsDir = join(squadDir, "jobs");
      mkdirSync(jobsDir, { recursive: true });
      jobStore = new JobStore(jobsDir);
      iterationStore = new IterationStore(squadDir);
    } catch {
      squadConfig = null;
    }
  }

  // Suppress unused variable warnings
  void squadDir;
  void jobsDir;

  const handleQuit = useCallback(() => {
    rendererInstance?.destroy();
    process.exit(0);
  }, []);

  if (!configPath || !squadConfig || !jobStore || !iterationStore) {
    return (
      <box width="100%" height="100%" flexDirection="column" alignItems="center" justifyContent="center">
        <text fg={COLOR_RED} attributes={ATTR_BOLD}>エラー: ccsquad.yaml が見つかりません</text>
        <box height={1} />
        <text fg={COLOR_GRAY}>ccsquad.yaml が存在するディレクトリで実行してください</text>
        <box height={1} />
        <text fg={COLOR_GRAY}>Ctrl+Q で終了</text>
      </box>
    );
  }

  const config = squadConfig;
  const store = jobStore;
  const itStore = iterationStore;

  const navigateTo = useCallback((s: Screen) => {
    setScreen(s);
  }, []);

  if (screen.type === "normal") {
    return (
      <NormalMode
        onSwitchToWorkflow={() => {
          navigateTo({ type: "job-list" });
        }}
        onQuit={handleQuit}
      />
    );
  }

  if (screen.type === "job-list") {
    return (
      <JobListView
        store={store}
        config={config}
        iterationStore={itStore}
        onStartJob={(jobId, phase) => {
          navigateTo({ type: "phase-running", jobId, phase });
        }}
        onResumeJob={(job, _wf) => {
          const phase = job.frontmatter.current_phase;
          if (phase) {
            navigateTo({ type: "phase-running", jobId: job.frontmatter.id, phase });
          }
        }}
        onCreateJob={() => {
          navigateTo({ type: "job-create" });
        }}
        onSwitchToNormal={() => {
          navigateTo({ type: "normal" });
        }}
        onQuit={handleQuit}
      />
    );
  }

  if (screen.type === "phase-running") {
    const { jobId, phase } = screen;
    return (
      <PhaseRunningView
        key={`${jobId}-${phase}`}
        jobId={jobId}
        phase={phase}
        store={store}
        config={config}
        iterationStore={itStore}
        onTransition={(info) => {
          navigateTo({ type: "pause-review", jobId, phase: info.nextPhase, info });
        }}
        onDone={() => {
          navigateTo({ type: "job-list" });
        }}
        onQuit={handleQuit}
      />
    );
  }

  if (screen.type === "pause-review") {
    const { jobId, phase, info } = screen;
    return (
      <PauseReviewView
        jobId={jobId}
        phase={phase}
        info={info}
        store={store}
        config={config}
        iterationStore={itStore}
        onRunAgent={(jId, nextPhase) => {
          navigateTo({ type: "phase-running", jobId: jId, phase: nextPhase });
        }}
        onDone={() => {
          navigateTo({ type: "job-list" });
        }}
        onQuit={handleQuit}
      />
    );
  }

  if (screen.type === "job-create") {
    return (
      <JobCreateView
        config={config}
        store={store}
        onCreated={() => {
          navigateTo({ type: "job-list" });
        }}
        onCancel={() => {
          navigateTo({ type: "job-list" });
        }}
        onQuit={handleQuit}
      />
    );
  }

  return null;
}

export async function launchTui(): Promise<void> {
  rendererInstance = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(rendererInstance).render(<App />);
}
