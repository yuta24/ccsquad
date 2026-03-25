import { connect } from "node:net";
import { join, dirname } from "node:path";
import { findConfigOrThrow } from "../service/context.js";

export function cmdSignal(event: string, jobId?: string): void {
  const configPath = findConfigOrThrow();
  const projectRoot = dirname(configPath);
  const sockPath = join(projectRoot, ".ccsquad", "ccsquad.sock");

  const payload = JSON.stringify({ event, job_id: jobId });

  const socket = connect(sockPath, () => {
    socket.write(payload);
    socket.end();
  });

  socket.on("error", (_err) => {
    // TUI が起動していない場合などは静かに失敗
    // hook から呼ばれるため、エラーで Claude Code を止めたくない
    process.exit(0);
  });

  socket.on("close", () => {
    process.exit(0);
  });
}
