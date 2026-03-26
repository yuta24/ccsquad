import { useMemo } from "react";
import { COLOR_WHITE, COLOR_GRAY, COLOR_DARK_GRAY } from "../constants.js";

interface ScrollableTextProps {
  lines: string[];
  height: number;
  offset: number;
  title?: string;
}

export function ScrollableText({ lines, height, offset, title }: ScrollableTextProps) {
  const { visibleLines, hasAbove, hasBelow, belowCount } = useMemo(() => {
    const hasAbove = offset > 0;
    const wouldHaveBelow = offset + height < lines.length;
    // Reserve rows for indicators
    const indicatorRows = (hasAbove ? 1 : 0) + (wouldHaveBelow ? 1 : 0);
    const viewableHeight = Math.max(1, height - indicatorRows);

    const visibleLines = lines.slice(offset, offset + viewableHeight);
    const hasBelow = offset + viewableHeight < lines.length;
    const belowCount = lines.length - offset - viewableHeight;

    return { visibleLines, hasAbove, hasBelow, belowCount };
  }, [lines, height, offset]);

  return (
    <box flexGrow={1} flexDirection="column" borderStyle="single" borderColor={COLOR_GRAY} padding={1}>
      {title ? <text fg={COLOR_WHITE}>{title}</text> : null}
      {hasAbove && (
        <box height={1} paddingLeft={1}>
          <text fg={COLOR_DARK_GRAY}>  ▲ {offset} 行上</text>
        </box>
      )}
      {visibleLines.map((line, i) => (
        <text key={i} fg={COLOR_WHITE}>{line}</text>
      ))}
      {hasBelow && (
        <box height={1} paddingLeft={1}>
          <text fg={COLOR_DARK_GRAY}>  ▼ {belowCount} 行下</text>
        </box>
      )}
    </box>
  );
}
