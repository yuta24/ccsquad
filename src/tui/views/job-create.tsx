import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useMemo } from "react";
import type { SquadConfig } from "../../config.js";
import { JobStore } from "../../job.js";
import { useSyncedState } from "../hooks/use-synced-state.js";
import { StatusBar } from "../components/status-bar.js";
import {
  ATTR_BOLD, COLOR_WHITE, COLOR_GRAY, COLOR_CYAN, COLOR_YELLOW,
  COLOR_RED, COLOR_HEADER_BG,
} from "../constants.js";

interface JobCreateViewProps {
  config: SquadConfig;
  store: JobStore;
  onCreated: () => void;
  onCancel: () => void;
}

export function JobCreateView({ config, store, onCreated, onCancel }: JobCreateViewProps) {
  const [focusIndex, setFocusIndex, focusRef] = useSyncedState(0);
  const [title, setTitle, titleRef] = useSyncedState("");
  const [workflowIndex, setWorkflowIndex, workflowIndexRef] = useSyncedState(0);
  const [priority, setPriority, priorityRef] = useSyncedState("0");
  const [description, setDescription, descriptionRef] = useSyncedState("");
  const [errorMsg, setErrorMsg] = useSyncedState<string | null>(null);
  const FIELD_COUNT = 4;

  const workflowNames = Object.keys(config.workflows);
  const maxVisibleWf = 3;
  const wfViewStart = useMemo(() => {
    const total = workflowNames.length;
    if (total <= maxVisibleWf) return 0;
    const half = Math.floor(maxVisibleWf / 2);
    return Math.max(0, Math.min(workflowIndex - half, total - maxVisibleWf));
  }, [workflowIndex, workflowNames.length]);

  const handleCreate = useCallback(() => {
    const t = titleRef.current.trim();
    if (!t) { setErrorMsg("タイトルは必須です"); return; }
    const wfName = workflowNames[workflowIndexRef.current];
    if (!wfName) { setErrorMsg("ワークフローを選択してください"); return; }
    const pri = parseInt(priorityRef.current, 10) || 0;
    const desc = descriptionRef.current.trim();

    try {
      const id = store.nextId();
      const now = new Date().toISOString();
      const body = desc ? `## 説明\n${desc}\n` : "";
      store.save({
        frontmatter: {
          id, title: t, workflow: wfName, status: "pending",
          current_phase: undefined, priority: pri, depends_on: [],
          created_at: now, updated_at: now,
        },
        body,
      });
      onCreated();
    } catch (e) {
      setErrorMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [store, workflowNames, onCreated, titleRef, workflowIndexRef, priorityRef, descriptionRef, setErrorMsg]);

  useKeyboard((event: KeyEvent) => {
    if (event.name === "escape") { onCancel(); event.preventDefault(); return; }

    // Tab / Shift+Tab: move focus
    if (event.name === "tab") {
      const newFocus = event.shift
        ? Math.max(0, focusRef.current - 1)
        : Math.min(FIELD_COUNT - 1, focusRef.current + 1);
      setFocusIndex(newFocus);
      event.preventDefault();
      return;
    }

    const fi = focusRef.current;

    // Ctrl+Enter to submit
    if (event.ctrl && (event.name === "return" || event.name === "enter")) {
      handleCreate();
      event.preventDefault();
      return;
    }

    // Title field (focus 0)
    if (fi === 0) {
      if (event.name === "backspace" || event.name === "delete") {
        setTitle((prev) => [...prev].slice(0, -1).join(""));
        event.preventDefault();
        return;
      }
      if (event.name === "return" || event.name === "enter") {
        setFocusIndex(1);
        event.preventDefault();
        return;
      }
      if (!event.ctrl && !event.meta && event.sequence && event.sequence.length === 1) {
        setTitle((prev) => prev + event.sequence);
        event.preventDefault();
        return;
      }
    }

    // Workflow select (focus 1)
    if (fi === 1) {
      if (event.name === "up" || event.name === "k") {
        setWorkflowIndex(Math.max(0, workflowIndexRef.current - 1));
        event.preventDefault();
        return;
      }
      if (event.name === "down" || event.name === "j") {
        setWorkflowIndex(Math.min(workflowNames.length - 1, workflowIndexRef.current + 1));
        event.preventDefault();
        return;
      }
      if (event.name === "return" || event.name === "enter") {
        setFocusIndex(2);
        event.preventDefault();
        return;
      }
    }

    // Priority field (focus 2)
    if (fi === 2) {
      if (event.name === "backspace" || event.name === "delete") {
        setPriority((prev) => [...prev].slice(0, -1).join(""));
        event.preventDefault();
        return;
      }
      if (event.name === "return" || event.name === "enter") {
        setFocusIndex(3);
        event.preventDefault();
        return;
      }
      if (!event.ctrl && !event.meta && event.sequence && /^[0-9\-]$/.test(event.sequence)) {
        setPriority((prev) => prev + event.sequence);
        event.preventDefault();
        return;
      }
    }

    // Description textarea (focus 3)
    if (fi === 3) {
      if (event.name === "backspace" || event.name === "delete") {
        setDescription((prev) => [...prev].slice(0, -1).join(""));
        event.preventDefault();
        return;
      }
      if (event.name === "return" || event.name === "enter") {
        setDescription((prev) => prev + "\n");
        event.preventDefault();
        return;
      }
      if (!event.ctrl && !event.meta && event.sequence && event.sequence.length === 1) {
        setDescription((prev) => prev + event.sequence);
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
      <box height={1} backgroundColor={COLOR_HEADER_BG}>
        <text fg={COLOR_CYAN} attributes={ATTR_BOLD}> ジョブ作成 </text>
      </box>

      <box flexGrow={1} flexDirection="column" padding={1}>
        <box flexDirection="column" marginBottom={1}>
          <text fg={fieldLabelColor(0)}>タイトル (必須):</text>
          <box borderStyle="single" borderColor={fieldBorderColor(0)} height={3} paddingLeft={1} paddingRight={1}>
            <text fg={COLOR_WHITE}>{title}{focusIndex === 0 ? "█" : ""}</text>
          </box>
        </box>

        <box flexDirection="column" marginBottom={1}>
          <text fg={fieldLabelColor(1)}>ワークフロー (必須):</text>
          <box borderStyle="single" borderColor={fieldBorderColor(1)} paddingLeft={1} paddingRight={1}>
            {workflowNames.length === 0 ? (
              <text fg={COLOR_RED}>ワークフローが定義されていません</text>
            ) : (
              (() => {
                const total = workflowNames.length;
                const end = Math.min(wfViewStart + maxVisibleWf, total);
                const visible = workflowNames.slice(wfViewStart, end);
                const hasAbove = wfViewStart > 0;
                const hasBelow = end < total;
                return <>
                  {hasAbove && <text fg={COLOR_GRAY}>  ↑ {wfViewStart} more</text>}
                  {visible.map((wfName, i) => {
                    const realIdx = wfViewStart + i;
                    return <text key={wfName} fg={realIdx === workflowIndex ? COLOR_CYAN : COLOR_GRAY} attributes={realIdx === workflowIndex ? ATTR_BOLD : 0}>
                      {realIdx === workflowIndex ? "▶ " : "  "}{wfName}
                    </text>;
                  })}
                  {hasBelow && <text fg={COLOR_GRAY}>  ↓ {total - end} more</text>}
                </>;
              })()
            )}
          </box>
        </box>

        <box flexDirection="column" marginBottom={1}>
          <text fg={fieldLabelColor(2)}>優先度 (デフォルト: 0):</text>
          <box borderStyle="single" borderColor={fieldBorderColor(2)} height={3} paddingLeft={1}>
            <text fg={COLOR_WHITE}>{priority}{focusIndex === 2 ? "█" : ""}</text>
          </box>
        </box>

        <box flexDirection="column" flexGrow={1}>
          <text fg={fieldLabelColor(3)}>説明 (任意、Ctrl+Enter で確定):</text>
          <box borderStyle="single" borderColor={fieldBorderColor(3)} flexGrow={1} paddingLeft={1}>
            <text fg={COLOR_WHITE}>{description}{focusIndex === 3 ? "█" : ""}</text>
          </box>
        </box>

        {errorMsg ? (
          <box height={1} paddingLeft={1}>
            <text fg={COLOR_RED}>{errorMsg}</text>
          </box>
        ) : null}
      </box>

      <StatusBar items={[
        { key: "Tab", label: "次フィールド" }, { key: "Shift+Tab", label: "前フィールド" },
        { key: "Ctrl+Enter", label: "作成" }, { key: "Esc", label: "キャンセル" },
      ]} />
    </box>
  );
}
