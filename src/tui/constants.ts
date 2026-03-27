export { truncate, padRight } from "../util.js";

// Attribute flags matching OpenTUI
export const ATTR_BOLD = 1;
export const ATTR_ITALIC = 4;
export const ATTR_UNDERLINE = 8;
export const ATTR_STRIKETHROUGH = 128;

// Color constants (hex strings for OpenTUI)
export const COLOR_WHITE = "#ffffff";
export const COLOR_GRAY = "#888888";
export const COLOR_CYAN = "#00ffff";
export const COLOR_YELLOW = "#ffff00";
export const COLOR_GREEN = "#00ff00";
export const COLOR_RED = "#ff4444";
export const COLOR_DARK_RED = "#8b0000";
export const COLOR_DARK_GRAY = "#555555";
export const COLOR_SELECTED_BG = "#2d4a6e";
export const COLOR_HEADER_BG = "#1a1a2e";
export const COLOR_WARN_BG = "#5a0000";
export const COLOR_SUCCESS_BG = "#1a3a1a";
export const COLOR_DARK_BG = "#1a1a1a";
export const COLOR_COL_HEADER_BG = "#252525";

// Screen types
export interface TransitionInfo {
  prevPhase: string;
  result: string;
  message: string;
  nextPhase: string;
  description?: string;
  agent?: string;
  reviewer?: string;
  phaseType?: string;
  reason?: "max_iterations";
  sessionId?: string;
}

export type Screen =
  | { type: "job-list" }
  | { type: "phase-running"; jobId: string; phase: string }
  | { type: "pause-review"; jobId: string; phase: string; info: TransitionInfo }
  | { type: "job-create" };

// Status bar item
export interface StatusBarItem {
  key: string;
  label: string;
}

// truncateStr is kept as an alias for backward compatibility
export { truncate as truncateStr } from "../util.js";
