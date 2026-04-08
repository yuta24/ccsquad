import { render, useKeyboard, extend } from "@opentui/solid";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";
import { createSignal, createEffect, onCleanup, Show } from "solid-js";
import { Sidebar } from "./components/Sidebar.js";
import { LogPanel } from "./components/LogPanel.js";
import { JobDetail } from "./components/JobDetail.js";
import { readLogFile, fetchJobShow } from "./ccsquad-client.js";
import { createProjectContext } from "../app/project-context.js";
import { launchJob, resumeJob } from "./launcher.js";
import type { DagStatusJob } from "./types.js";

extend({ "ghostty-terminal": GhosttyTerminalRenderable });

const ctx = createProjectContext();

function App() {
  const [jobs, setJobs] = createSignal<DagStatusJob[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [focusPanel, setFocusPanel] = createSignal<"sidebar" | "main">("sidebar");
  const [logContent, setLogContent] = createSignal("");
  const [jobBody, setJobBody] = createSignal("");
  const [launching, setLaunching] = createSignal<string | null>(null);
  const [statusMessage, setStatusMessage] = createSignal("");

  const selectedJob = () => jobs()[selectedIndex()] ?? null;

  // Polling for job status every 2 seconds
  const poll = () => {
    try {
      const allJobs = ctx.jobStore.listAll();
      const result: DagStatusJob[] = allJobs.map((j) => ({
        id: j.frontmatter.id,
        title: j.frontmatter.title,
        status: j.frontmatter.status,
        current_phase: j.frontmatter.current_phase ?? null,
        iteration: j.frontmatter.iteration,
        worktree_exists: ctx.worktreeManager.exists(j.frontmatter.id),
      }));
      setJobs(result);
      // Clamp selected index
      if (selectedIndex() >= result.length && result.length > 0) {
        setSelectedIndex(result.length - 1);
      }
    } catch {
      // silently ignore polling errors
    }
  };

  // Initial fetch
  poll();
  const pollTimer = setInterval(poll, 2000);
  onCleanup(() => clearInterval(pollTimer));

  // Update log/body when selected job changes
  createEffect(async () => {
    const job = selectedJob();
    if (!job) {
      setLogContent("");
      setJobBody("");
      return;
    }

    if (job.status === "running") {
      try {
        const log = await readLogFile(job.id);
        setLogContent(log);
      } catch {
        setLogContent("");
      }
    } else {
      try {
        const detail = await fetchJobShow(job.id);
        setJobBody(detail.body);
      } catch {
        setJobBody("(failed to load job detail)");
      }
    }
  });

  // Refresh log for running jobs periodically
  const logTimer = setInterval(async () => {
    const job = selectedJob();
    if (job?.status === "running") {
      try {
        const log = await readLogFile(job.id);
        setLogContent(log);
      } catch {
        // ignore
      }
    }
  }, 2000);
  onCleanup(() => clearInterval(logTimer));

  useKeyboard((key) => {
    if (key.name === "q") {
      process.exit(0);
    }

    if (key.name === "tab") {
      setFocusPanel((prev) => (prev === "sidebar" ? "main" : "sidebar"));
      return;
    }

    // Launch / resume job
    if (key.name === "return" && focusPanel() === "sidebar") {
      const job = selectedJob();
      if (!job) return;
      if (launching()) return;

      const canLaunch = job.status === "pending";
      const canResume = job.status === "running" || job.status === "paused";
      if (!canLaunch && !canResume) return;

      setLaunching(job.id);
      setStatusMessage(`起動中: ${job.id}...`);

      (async () => {
        try {
          if (canLaunch) {
            await launchJob(ctx, job.id);
          } else {
            await resumeJob(ctx, job.id);
          }
          setStatusMessage(`起動完了: ${job.id}`);
          poll();
          setTimeout(() => setStatusMessage(""), 3000);
        } catch (e) {
          setStatusMessage(`エラー: ${e instanceof Error ? e.message : String(e)}`);
          setTimeout(() => setStatusMessage(""), 5000);
        } finally {
          setLaunching(null);
        }
      })();
      return;
    }

    // Sidebar navigation when sidebar is focused
    if (focusPanel() === "sidebar") {
      const jobCount = jobs().length;
      if (jobCount === 0) return;

      if (key.name === "j" || key.name === "arrow_down") {
        setSelectedIndex((prev) => Math.min(prev + 1, jobCount - 1));
      } else if (key.name === "k" || key.name === "arrow_up") {
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      }
    }
  });

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <Sidebar
          jobs={jobs()}
          selectedIndex={selectedIndex()}
          focused={focusPanel() === "sidebar"}
          launchingId={launching()}
        />
        <Show
          when={selectedJob()?.status === "running"}
          fallback={
            <JobDetail
              job={selectedJob()}
              jobBody={jobBody()}
              focused={focusPanel() === "main"}
            />
          }
        >
          <LogPanel
            jobId={selectedJob()!.id}
            logContent={logContent()}
            focused={focusPanel() === "main"}
          />
        </Show>
      </box>
      <box style={{ height: 1, flexShrink: 0 }}>
        <text fg="gray">{statusMessage() || " q:quit  Tab:switch  j/k:navigate  Enter:launch/resume"}</text>
      </box>
    </box>
  );
}

export function startTui(): void {
  render(() => <App />);
}
