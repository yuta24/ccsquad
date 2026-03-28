import { connect } from "node:net";
import { join, dirname } from "node:path";
import { findConfigPathOrThrow } from "../../infra/config-loader.js";

export function cmdSignal(event: string, jobId?: string): void {
  const configPath = findConfigPathOrThrow();
  const projectRoot = dirname(configPath);
  const sockPath = join(projectRoot, ".ccsquad", "ccsquad.sock");

  const payload = JSON.stringify({ event, job_id: jobId });

  const socket = connect(sockPath, () => {
    socket.write(payload);
    socket.end();
  });

  socket.on("error", (_err) => {
    process.exit(0);
  });

  socket.on("close", () => {
    process.exit(0);
  });
}
