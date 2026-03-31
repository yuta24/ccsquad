/** Return the display width of a single character (2 for CJK fullwidth, 1 otherwise). */
function charWidth(code: number): number {
  // CJK Unified Ideographs, CJK Extension A/B, Compatibility Ideographs
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK Radicals, Kangxi, Ideographic Desc, CJK Symbols
    (code >= 0x3041 && code <= 0x33bf) || // Hiragana, Katakana, Bopomofo, Compat Jamo, CJK Compat
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext A
    (code >= 0x4e00 && code <= 0xa4cf) || // CJK Unified, Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compat Ideographs
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compat Forms, Small Forms
    (code >= 0xff01 && code <= 0xff60) || // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
    (code >= 0x20000 && code <= 0x2fa1f) // CJK Ext B–F, Compat Supplement
  ) {
    return 2;
  }
  return 1;
}

/** Return the display width of a string (CJK characters count as 2). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += charWidth(ch.codePointAt(0)!);
  }
  return w;
}

export function truncate(s: string, maxWidth: number): string {
  if (displayWidth(s) <= maxWidth) return s;
  let w = 0;
  let i = 0;
  const chars = [...s];
  for (; i < chars.length; i++) {
    const cw = charWidth(chars[i].codePointAt(0)!);
    if (w + cw > maxWidth - 2) break;
    w += cw;
  }
  return chars.slice(0, i).join("") + "..";
}

export function padRight(s: string, width: number): string {
  const w = displayWidth(s);
  if (w >= width) return s;
  return s + " ".repeat(width - w);
}
