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
