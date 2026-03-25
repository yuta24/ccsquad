import { RGBA, type OptimizedBuffer } from "@opentui/core";
import { StyleFlags, type TerminalData } from "ghostty-opentui";

// --- RGBA cache for performance ---
const rgbaCache = new Map<number, RGBA>();

export function getCachedRGBA(r: number, g: number, b: number): RGBA {
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

export const DEFAULT_FG = getCachedRGBA(212, 212, 212); // #d4d4d4
export const DEFAULT_BG = getCachedRGBA(30, 30, 30);    // #1e1e1e
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

// Attribute flags matching OpenTUI
const ATTR_BOLD = 1;
const ATTR_ITALIC = 4;
const ATTR_UNDERLINE = 8;
const ATTR_STRIKETHROUGH = 128;

export function renderTerminalToBuffer(
  buffer: OptimizedBuffer,
  data: TerminalData,
  offsetX: number,
  offsetY: number,
): void {
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
