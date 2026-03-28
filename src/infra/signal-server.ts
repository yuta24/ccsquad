import { createServer } from "node:net";
import type { Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

export interface SignalMessage {
  event: string;
  job_id?: string;
}

export type SignalHandler = (message: SignalMessage) => void;

export function createSignalServer(
  sockPath: string,
  handler: SignalHandler,
): Server {
  if (existsSync(sockPath)) {
    unlinkSync(sockPath);
  }

  const server = createServer((conn) => {
    let data = "";
    conn.on("data", (chunk) => {
      data += chunk.toString();
    });
    conn.on("end", () => {
      try {
        const msg = JSON.parse(data) as SignalMessage;
        handler(msg);
      } catch {
        // invalid JSON は無視
      }
    });
  });

  server.listen(sockPath);

  const cleanup = () => {
    try {
      server.close();
      if (existsSync(sockPath)) {
        unlinkSync(sockPath);
      }
    } catch {
      // ignore
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  return server;
}
