import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback } from "react";
import type { TransitionInfo, StatusBarItem } from "../constants.js";
import {
  ATTR_BOLD, COLOR_WHITE, COLOR_GRAY, COLOR_CYAN, COLOR_YELLOW,
  COLOR_GREEN, COLOR_RED,
} from "../constants.js";
import { useSyncedState } from "../hooks/use-synced-state.js";

type ReviewMode = "browse" | "decide" | "feedback";

interface InlineReviewProps {
  info: TransitionInfo;
  onApprove: () => void;
  onReject: (feedback?: string) => void;
  onContinue: () => void;
  onEscape: () => void;
}

export function InlineReview({ info, onApprove, onReject, onContinue, onEscape }: InlineReviewProps) {
  const [reviewMode, setReviewMode, reviewModeRef] = useSyncedState<ReviewMode>("browse");
  const [feedbackText, setFeedbackText, feedbackTextRef] = useSyncedState("");

  const isHumanReview = info.phaseType === "review" && info.reviewer === "human";
  const isAgentReview = info.phaseType === "review" && info.reviewer !== "human";

  useKeyboard((event: KeyEvent) => {
    // Escape handling
    if (event.name === "escape") {
      const mode = reviewModeRef.current;
      if (mode === "feedback") {
        setReviewMode("decide");
        event.preventDefault();
        return;
      }
      if (mode === "decide") {
        setReviewMode("browse");
        event.preventDefault();
        return;
      }
      onEscape();
      event.preventDefault();
      return;
    }

    if (isHumanReview) {
      const mode = reviewModeRef.current;
      if (mode === "browse") {
        if (event.name === "return" || event.name === "enter") {
          setReviewMode("decide");
          event.preventDefault();
          return;
        }
      } else if (mode === "decide") {
        if (event.name === "a") { onApprove(); event.preventDefault(); return; }
        if (event.name === "x") { setReviewMode("feedback"); setFeedbackText(""); event.preventDefault(); return; }
      } else if (mode === "feedback") {
        if (event.ctrl && (event.name === "return" || event.name === "enter")) {
          onReject(feedbackTextRef.current);
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
        onContinue();
        event.preventDefault();
        return;
      }
      if (event.name === "a") { onApprove(); event.preventDefault(); return; }
      if (event.name === "x") { onReject(); event.preventDefault(); return; }
    } else {
      // max_iterations pause
      if (event.name === "return" || event.name === "enter") {
        onContinue();
        event.preventDefault();
        return;
      }
    }

    event.preventDefault();
  });

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={COLOR_YELLOW} attributes={ATTR_BOLD}>
        {info.reason === "max_iterations" ? "⚠ イテレーション上限" : "⏸ レビュー待ち"}
      </text>
      <box flexDirection="row" height={1}>
        <text fg={COLOR_GRAY}>前フェーズ: </text>
        <text fg={COLOR_WHITE}>{info.prevPhase}</text>
        <text fg={COLOR_GRAY}> → </text>
        <text fg={info.result === "completed" || info.result === "approved" ? COLOR_GREEN : COLOR_RED}>
          {info.result}
        </text>
      </box>
      <box flexDirection="row" height={1}>
        <text fg={COLOR_GRAY}>次フェーズ: </text>
        <text fg={COLOR_YELLOW}>{info.nextPhase}</text>
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
    </box>
  );
}

function getReviewStatusBarItems(info: TransitionInfo, reviewMode: ReviewMode): StatusBarItem[] {
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
}
