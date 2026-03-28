import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { join } from "node:path";
import type { Server } from "node:net";

import { findConfigPath } from "../infra/config-loader.js";
import { createProjectContext } from "../app/project-context.js";
import type { ProjectContext } from "../app/project-context.js";
import { JobService } from "../app/job-service.js";
import { OutputService } from "../app/output-service.js";
import { PhaseExecutor } from "../app/phase-executor.js";
import { createSignalServer } from "../infra/signal-server.js";
import type { SignalMessage } from "../infra/signal-server.js";

import type { Screen } from "./constants.js";
import { ATTR_BOLD, COLOR_RED, COLOR_GRAY } from "./constants.js";
import { JobListView } from "./views/job-list.js";
import { PhaseRunningView } from "./views/phase-running.js";
import { JobCreateView } from "./views/job-create.js";
import { PlanCreateView } from "./views/plan-create.js";

let rendererInstance: any = null;

function App() {
  const [screen, setScreen] = useState<Screen>({ type: "job-list" });

  const services = useMemo(() => {
    const configPath = findConfigPath();
    if (!configPath) return null;

    try {
      const ctx = createProjectContext(configPath);
      const jobService = new JobService(ctx);
      const outputService = new OutputService(ctx);
      const phaseExecutor = new PhaseExecutor(ctx, jobService, outputService);
      return { ctx, jobService, outputService, phaseExecutor };
    } catch {
      return null;
    }
  }, []);

  // Signal server for receiving hooks notifications
  const signalHandlerRef = useRef<((msg: SignalMessage) => void) | null>(null);
  const signalServerRef = useRef<Server | null>(null);

  useEffect(() => {
    if (!services) return;
    const sockPath = join(services.ctx.squadDir, "ccsquad.sock");

    const server = createSignalServer(sockPath, (msg) => {
      signalHandlerRef.current?.(msg);
    });
    signalServerRef.current = server;

    return () => {
      server.close();
      try {
        const { unlinkSync, existsSync } = require("node:fs");
        if (existsSync(sockPath)) unlinkSync(sockPath);
      } catch { /* ignore */ }
    };
  }, [services]);

  const handleQuit = useCallback(() => {
    signalServerRef.current?.close();
    rendererInstance?.destroy();
    process.exit(0);
  }, []);

  const navigateTo = useCallback((s: Screen) => {
    setScreen(s);
  }, []);

  if (!services) {
    return (
      <box width="100%" height="100%" flexDirection="column" alignItems="center" justifyContent="center">
        <text fg={COLOR_RED} attributes={ATTR_BOLD}>エラー: ccsquad.yaml が見つかりません</text>
        <box height={1} />
        <text fg={COLOR_GRAY}>ccsquad.yaml が存在するディレクトリで実行してください</text>
        <box height={1} />
        <text fg={COLOR_GRAY}>Esc で終了</text>
      </box>
    );
  }

  const { ctx, jobService, outputService, phaseExecutor } = services;

  switch (screen.type) {
    case "job-list":
      return (
        <JobListView
          ctx={ctx}
          jobService={jobService}
          onStartJob={(jobId, phase) => navigateTo({ type: "phase-running", jobId, phase })}
          onResumeJob={(job) => {
            const phase = job.frontmatter.current_phase;
            if (phase) navigateTo({ type: "phase-running", jobId: job.frontmatter.id, phase });
          }}
          onCreateJob={() => navigateTo({ type: "job-create" })}
          onPlanCreate={() => navigateTo({ type: "plan-create" })}
          onQuit={handleQuit}
        />
      );

    case "phase-running": {
      const { jobId, phase } = screen;
      return (
        <PhaseRunningView
          key={`${jobId}-${phase}`}
          jobId={jobId}
          phase={phase}
          ctx={ctx}
          jobService={jobService}
          outputService={outputService}
          phaseExecutor={phaseExecutor}
          signalHandlerRef={signalHandlerRef}
          onDone={() => navigateTo({ type: "job-list" })}
        />
      );
    }

    case "job-create":
      return (
        <JobCreateView
          ctx={ctx}
          jobService={jobService}
          onCreated={() => navigateTo({ type: "job-list" })}
          onCancel={() => navigateTo({ type: "job-list" })}
        />
      );

    case "plan-create":
      return (
        <PlanCreateView
          projectRoot={ctx.projectRoot}
          workflows={ctx.workflows}
          onDone={() => navigateTo({ type: "job-list" })}
        />
      );

    default:
      return null;
  }
}

export async function launchTui(): Promise<void> {
  const configPath = findConfigPath();
  if (!configPath) {
    console.error("エラー: ccsquad.yaml が見つかりません");
    console.error("ccsquad setup を実行するか、ccsquad.yaml が存在するディレクトリで実行してください");
    process.exit(1);
  }

  rendererInstance = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
  createRoot(rendererInstance).render(<App />);
}
