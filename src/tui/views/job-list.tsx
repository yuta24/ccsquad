import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState, useCallback, useEffect } from "react";
import type { SquadConfig, WorkflowConfig } from "../../config.js";
import type { Job } from "../../job.js";
import { JobStore } from "../../job.js";
import { WorkflowEngine } from "../../engine.js";
import type { IterationStore } from "../../iteration.js";
import { adjustViewportOffset } from "../../util.js";
import { useSyncedState } from "../hooks/use-synced-state.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { WorkflowDiagram } from "../components/workflow-diagram.js";
import { StatusBar } from "../components/status-bar.js";
import {
  ATTR_BOLD, COLOR_WHITE, COLOR_GRAY, COLOR_CYAN, COLOR_YELLOW,
  COLOR_GREEN, COLOR_RED, COLOR_DARK_RED, COLOR_DARK_GRAY,
  COLOR_SELECTED_BG, COLOR_HEADER_BG, COLOR_WARN_BG, COLOR_SUCCESS_BG,
  COLOR_COL_HEADER_BG, padRight, truncateStr,
} from "../constants.js";

interface JobListViewProps {
  store: JobStore;
  config: SquadConfig;
  iterationStore: IterationStore;
  onStartJob: (jobId: string, phase: string) => void;
  onResumeJob: (job: Job, workflowConfig: WorkflowConfig) => void;
  onCreateJob: () => void;
  onQuit: () => void;
}

export function JobListView({
  store, config, iterationStore,
  onStartJob, onResumeJob, onCreateJob, onQuit,
}: JobListViewProps) {
  const [cursor, setCursor, cursorRef] = useSyncedState(0);
  const [jobs, setJobs, jobsRef] = useSyncedState<Job[]>([]);
  const [confirmAction, setConfirmAction, confirmRef] = useSyncedState<{ type: "delete" | "abort"; jobId: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [viewportOffset, setViewportOffset, viewportOffsetRef] = useSyncedState(0);
  const { rows } = useTerminalSize();

  // Reserve: header(1) + border(2) + col-header(1) + workflow-diagram(4) + confirm/msg(1) + statusbar(1) = 10
  const viewportHeight = Math.max(rows - 10, 3);

  const loadJobs = useCallback(() => {
    try {
      const loaded = store.listAll();
      setJobs(loaded);
    } catch {
      setJobs([]);
    }
  }, [store, setJobs]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const adjustViewport = useCallback((newCursor: number) => {
    const offset = adjustViewportOffset(newCursor, viewportOffsetRef.current, viewportHeight);
    setViewportOffset(offset);
  }, [viewportHeight, viewportOffsetRef, setViewportOffset]);

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
          adjustViewport(newCursor);
        } catch (e) {
          setMessage(`エラー: ${e instanceof Error ? e.message : String(e)}`);
        }
        event.preventDefault();
        return;
      }
      if (event.name === "n" || event.name === "N" || event.name === "escape") {
        setConfirmAction(null);
        event.preventDefault();
        return;
      }
      event.preventDefault();
      return;
    }

    if (event.ctrl && event.name === "q") { onQuit(); event.preventDefault(); return; }

    if (event.name === "up" || event.name === "k") {
      const newCursor = Math.max(0, cursorRef.current - 1);
      setCursor(newCursor);
      adjustViewport(newCursor);
      setMessage(null);
      event.preventDefault();
      return;
    }
    if (event.name === "down" || event.name === "j") {
      const newCursor = Math.min(jobsRef.current.length - 1, cursorRef.current + 1);
      setCursor(newCursor);
      adjustViewport(newCursor);
      setMessage(null);
      event.preventDefault();
      return;
    }

    if (event.name === "return" || event.name === "enter") {
      const job = jobsRef.current[cursorRef.current];
      if (!job) { event.preventDefault(); return; }
      const fm = job.frontmatter;
      if (fm.status === "pending") {
        try {
          const wf = config.getWorkflow(fm.workflow);
          if (!wf) { setMessage(`ワークフロー '${fm.workflow}' が見つかりません`); event.preventDefault(); return; }
          const engine = new WorkflowEngine(wf, store);
          const startedJob = engine.startJob(fm.id);
          const phase = startedJob.frontmatter.current_phase ?? wf.initialPhase().name;
          onStartJob(fm.id, phase);
        } catch (e) {
          setMessage(`エラー: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (fm.status === "running") {
        const wf = config.getWorkflow(fm.workflow);
        if (wf) { onResumeJob(job, wf); } else { setMessage(`ワークフロー '${fm.workflow}' が見つかりません`); }
      } else {
        setMessage(`ステータス '${fm.status}' のジョブは開始できません`);
      }
      event.preventDefault();
      return;
    }

    if (event.name === "n") { onCreateJob(); event.preventDefault(); return; }

    if (event.name === "d") {
      const job = jobsRef.current[cursorRef.current];
      if (job) { setConfirmAction({ type: "delete", jobId: job.frontmatter.id }); setMessage(null); }
      event.preventDefault();
      return;
    }

    if (event.name === "a") {
      const job = jobsRef.current[cursorRef.current];
      if (job && (job.frontmatter.status === "running" || job.frontmatter.status === "pending")) {
        setConfirmAction({ type: "abort", jobId: job.frontmatter.id }); setMessage(null);
      } else {
        setMessage("中断できるジョブがありません");
      }
      event.preventDefault();
      return;
    }

    if (event.name === "r") { loadJobs(); setMessage("ジョブ一覧を更新しました"); event.preventDefault(); return; }
  });

  const headerLine = `${padRight("ID", 10)} ${padRight("タイトル", 28)} ${padRight("ワークフロー", 12)} ${padRight("ステータス", 12)} ${padRight("フェーズ", 15)} ${padRight("優先度", 4)}`;

  const visibleJobs = jobs.slice(viewportOffset, viewportOffset + viewportHeight);
  const hasAbove = viewportOffset > 0;
  const hasBelow = viewportOffset + viewportHeight < jobs.length;

  return (
    <box width="100%" height="100%" flexDirection="column">
      <box width="100%" height={1} backgroundColor={COLOR_HEADER_BG}>
        <text fg={COLOR_CYAN} attributes={ATTR_BOLD}> CCSQUAD - ジョブ管理 </text>
      </box>

      <box flexDirection="column" width="100%" flexGrow={1} borderStyle="single" borderColor={COLOR_GRAY}>
        <box height={1} backgroundColor={COLOR_COL_HEADER_BG} paddingLeft={1}>
          <text fg={COLOR_GRAY}>{headerLine}</text>
        </box>

        {hasAbove && (
          <box height={1} paddingLeft={1}>
            <text fg={COLOR_DARK_GRAY}>  ▲ {viewportOffset} 件上</text>
          </box>
        )}

        {jobs.length === 0 ? (
          <box alignItems="center" justifyContent="center" flexGrow={1}>
            <text fg={COLOR_GRAY}>ジョブがありません。n キーで新規作成</text>
          </box>
        ) : (
          visibleJobs.map((job, idx) => {
            const fm = job.frontmatter;
            const absoluteIdx = idx + viewportOffset;
            const isSelected = absoluteIdx === cursor;
            const line = `${padRight(fm.id, 10)} ${padRight(truncateStr(fm.title, 26), 28)} ${padRight(truncateStr(fm.workflow, 10), 12)} ${padRight(fm.status, 12)} ${padRight(fm.current_phase ?? "-", 15)} ${padRight(String(fm.priority), 4)}`;
            return (
              <box key={fm.id} height={1} paddingLeft={1} backgroundColor={isSelected ? COLOR_SELECTED_BG : undefined}>
                <text fg={isSelected ? COLOR_WHITE : statusColor(fm.status)} attributes={isSelected ? ATTR_BOLD : 0}>{line}</text>
              </box>
            );
          })
        )}

        {hasBelow && (
          <box height={1} paddingLeft={1}>
            <text fg={COLOR_DARK_GRAY}>  ▼ {jobs.length - viewportOffset - viewportHeight} 件下</text>
          </box>
        )}
      </box>

      {selectedJob && selectedWorkflow && (
        <box flexDirection="column" width="100%" borderStyle="single" borderColor={COLOR_GRAY} height={4}>
          <box height={1} paddingLeft={1}>
            <text fg={COLOR_GRAY} attributes={ATTR_BOLD}>ワークフロー: </text>
            <text fg={COLOR_YELLOW}>{selectedJob.frontmatter.workflow}</text>
          </box>
          <box height={1} paddingLeft={1}>
            <WorkflowDiagram phases={selectedWorkflow.phases} currentPhase={selectedJob.frontmatter.current_phase} />
          </box>
        </box>
      )}

      {confirmAction && (
        <box height={1} backgroundColor={COLOR_WARN_BG} paddingLeft={1}>
          <text fg={COLOR_WHITE}>
            {confirmAction.type === "delete"
              ? `ジョブ ${confirmAction.jobId} を削除しますか？ [y/n]`
              : `ジョブ ${confirmAction.jobId} を中断しますか？ [y/n]`}
          </text>
        </box>
      )}

      {message && !confirmAction && (
        <box height={1} paddingLeft={1} backgroundColor={COLOR_SUCCESS_BG}>
          <text fg={COLOR_GREEN}>{message}</text>
        </box>
      )}

      <StatusBar items={[
        { key: "↑/k", label: "上" }, { key: "↓/j", label: "下" },
        { key: "Enter", label: "開始/再開" }, { key: "n", label: "新規作成" },
        { key: "d", label: "削除" }, { key: "a", label: "中断" },
        { key: "r", label: "更新" }, { key: "Ctrl+Q", label: "終了" },
      ]} />
    </box>
  );
}
