import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Server } from "node:net";

import { SquadConfigImpl } from "../config.js";
import type { SquadConfig } from "../config.js";
import { JobStore } from "../job.js";
import { IterationStore } from "../iteration.js";
import { OutputStore } from "../output.js";
import { findConfig } from "../service/context.js";
import { createSignalServer } from "../service/signal-server.js";
import type { SignalMessage } from "../service/signal-server.js";

import type { Screen } from "./constants.js";
import { ATTR_BOLD, COLOR_RED, COLOR_GRAY } from "./constants.js";
import { NormalMode } from "./views/normal-mode.js";
import { JobListView } from "./views/job-list.js";
import { PhaseRunningView } from "./views/phase-running.js";
import { PauseReviewView } from "./views/pause-review.js";
import { JobCreateView } from "./views/job-create.js";

let rendererInstance: any = null;

function App() {
  const [screen, setScreen] = useState<Screen>({ type: "normal" });

  const { configPath, squadConfig, jobStore, iterationStore, outputStore } = useMemo(() => {
    const configPath = findConfig();
    let squadConfig: SquadConfig | null = null;
    let jobStore: JobStore | null = null;
    let iterationStore: IterationStore | null = null;
    let outputStore: OutputStore | null = null;

    if (configPath) {
      try {
        squadConfig = SquadConfigImpl.load(configPath);
        const projectRoot = dirname(configPath);
        const squadDir = join(projectRoot, ".ccsquad");
        const jobsDir = join(squadDir, "jobs");
        const outputsDir = join(squadDir, "outputs");
        mkdirSync(jobsDir, { recursive: true });
        mkdirSync(outputsDir, { recursive: true });
        jobStore = new JobStore(jobsDir);
        iterationStore = new IterationStore(squadDir);
        outputStore = new OutputStore(outputsDir);
      } catch {
        squadConfig = null;
      }
    }

    return { configPath, squadConfig, jobStore, iterationStore, outputStore };
  }, []);

  // Signal server for receiving hooks notifications
  const signalHandlerRef = useRef<((msg: SignalMessage) => void) | null>(null);
  const signalServerRef = useRef<Server | null>(null);

  useEffect(() => {
    if (!configPath) return;
    const projectRoot = dirname(configPath);
    const sockPath = join(projectRoot, ".ccsquad", "ccsquad.sock");

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
  }, [configPath]);

  const handleQuit = useCallback(() => {
    signalServerRef.current?.close();
    rendererInstance?.destroy();
    process.exit(0);
  }, []);

  const navigateTo = useCallback((s: Screen) => {
    setScreen(s);
  }, []);

  if (!configPath || !squadConfig || !jobStore || !iterationStore || !outputStore) {
    return (
      <box width="100%" height="100%" flexDirection="column" alignItems="center" justifyContent="center">
        <text fg={COLOR_RED} attributes={ATTR_BOLD}>エラー: ccsquad.yaml が見つかりません</text>
        <box height={1} />
        <text fg={COLOR_GRAY}>ccsquad.yaml が存在するディレクトリで実行してください</text>
        <box height={1} />
        <text fg={COLOR_GRAY}>Ctrl+Q で終了</text>
      </box>
    );
  }

  const cfg = squadConfig;
  const store = jobStore;
  const itStore = iterationStore;
  const outStore = outputStore;

  switch (screen.type) {
    case "normal":
      return (
        <NormalMode
          onSwitchToWorkflow={() => navigateTo({ type: "job-list" })}
          onQuit={handleQuit}
        />
      );

    case "job-list":
      return (
        <JobListView
          store={store} config={cfg} iterationStore={itStore}
          onStartJob={(jobId, phase) => navigateTo({ type: "phase-running", jobId, phase })}
          onResumeJob={(job) => {
            const phase = job.frontmatter.current_phase;
            if (phase) navigateTo({ type: "phase-running", jobId: job.frontmatter.id, phase });
          }}
          onCreateJob={() => navigateTo({ type: "job-create" })}
          onSwitchToNormal={() => navigateTo({ type: "normal" })}
          onQuit={handleQuit}
        />
      );

    case "phase-running": {
      const { jobId, phase } = screen;
      return (
        <PhaseRunningView
          key={`${jobId}-${phase}`}
          jobId={jobId} phase={phase}
          store={store} config={cfg} iterationStore={itStore}
          projectRoot={dirname(configPath)}
          outputStore={outStore}
          onTransition={(info) => navigateTo({ type: "pause-review", jobId, phase: info.nextPhase, info })}
          onDone={() => navigateTo({ type: "job-list" })}
          onQuit={handleQuit}
        />
      );
    }

    case "pause-review": {
      const { jobId, phase, info } = screen;
      return (
        <PauseReviewView
          jobId={jobId} phase={phase} info={info}
          store={store} config={cfg} iterationStore={itStore}
          onRunAgent={(jId, nextPhase) => navigateTo({ type: "phase-running", jobId: jId, phase: nextPhase })}
          onDone={() => navigateTo({ type: "job-list" })}
          onQuit={handleQuit}
        />
      );
    }

    case "job-create":
      return (
        <JobCreateView
          config={cfg} store={store}
          onCreated={() => navigateTo({ type: "job-list" })}
          onCancel={() => navigateTo({ type: "job-list" })}
          onQuit={handleQuit}
        />
      );

    default:
      return null;
  }
}

export async function launchTui(): Promise<void> {
  rendererInstance = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(rendererInstance).render(<App />);
}
