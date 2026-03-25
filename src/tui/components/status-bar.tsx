import { COLOR_YELLOW } from "../constants.js";
import type { StatusBarItem } from "../constants.js";

interface StatusBarProps {
  items: StatusBarItem[];
}

export function StatusBar({ items }: StatusBarProps) {
  const content = items.map((item) => ` [${item.key}] ${item.label} `).join("");
  return (
    <box width="100%" height={1} backgroundColor="#333333">
      <text fg={COLOR_YELLOW}>{content}</text>
    </box>
  );
}
