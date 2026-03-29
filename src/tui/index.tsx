import { render, useKeyboard, extend } from "@opentui/solid";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";
import { createSignal, createEffect, onCleanup, Show } from "solid-js";
import { Sidebar } from "./components/Sidebar.js";
import { LogPanel } from "./components/LogPanel.js";
import { JobDetail } from "./components/JobDetail.js";
import { fetchDagStatus, readLogFile, fetchJobShow } from "./ccsquad-client.js";
import type { DagStatusJob } from "./types.js";

extend({ "ghostty-terminal": GhosttyTerminalRenderable });

function App() {
  const [jobs, setJobs] = createSignal<DagStatusJob[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [focusPanel, setFocusPanel] = createSignal<"sidebar" | "main">("sidebar");
  const [logContent, setLogContent] = createSignal("");
  const [jobBody, setJobBody] = createSignal("");

  const selectedJob = () => jobs()[selectedIndex()] ?? null;

  // Polling for job status every 2 seconds
  const poll = async () => {
    try {
      const result = await fetchDagStatus();
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
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <Sidebar
        jobs={jobs()}
        selectedIndex={selectedIndex()}
        focused={focusPanel() === "sidebar"}
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
  );
}

export function startTui(): void {
  render(() => <App />);
}
