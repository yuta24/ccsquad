import type { DisplayLine } from "../../infra/stream-parser.js";

export function OutputLine({ spans }: { spans: DisplayLine }) {
  if (spans.length === 0) return <box height={1} />;
  if (spans.length === 1) {
    return <text selectable fg={spans[0].color} attributes={spans[0].attrs}>{spans[0].text}</text>;
  }
  return (
    <box height={1} flexDirection="row">
      {spans.map((s, i) => (
        <text key={i} selectable fg={s.color} attributes={s.attrs}>{s.text}</text>
      ))}
    </box>
  );
}
