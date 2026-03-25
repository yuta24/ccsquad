export function truncate(s: string, maxLen: number): string {
  if ([...s].length <= maxLen) {
    return s;
  }
  return [...s].slice(0, maxLen - 2).join("") + "..";
}

export function padRight(s: string, len: number): string {
  const chars = [...s];
  if (chars.length >= len) return chars.slice(0, len).join("");
  return s + " ".repeat(len - chars.length);
}

/**
 * Calculate viewport offset to keep cursor visible within a scrollable list.
 * Returns the new offset value.
 */
export function adjustViewportOffset(
  cursor: number,
  currentOffset: number,
  viewportHeight: number,
): number {
  if (cursor < currentOffset) {
    return cursor;
  }
  if (cursor >= currentOffset + viewportHeight) {
    return cursor - viewportHeight + 1;
  }
  return currentOffset;
}
