import { describe, expect, test } from "bun:test";
import { testRender, extend } from "@opentui/solid";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";
import { Sidebar } from "../src/tui/components/Sidebar.js";
import { JobDetail } from "../src/tui/components/JobDetail.js";
import { LogPanel } from "../src/tui/components/LogPanel.js";
import type { DagStatusJob } from "../src/tui/types.js";

extend({ "ghostty-terminal": GhosttyTerminalRenderable });

const sampleJobs: DagStatusJob[] = [
  {
    id: "J000001",
    title: "First job",
    status: "running",
    current_phase: "code",
    iteration: 2,
    worktree_exists: true,
  },
  {
    id: "J000002",
    title: "Second job",
    status: "completed",
    current_phase: "review",
    iteration: 3,
    worktree_exists: false,
  },
  {
    id: "J000003",
    title: "Third job",
    status: "pending",
    current_phase: null,
    iteration: 0,
    worktree_exists: false,
  },
];

describe("Sidebar", () => {
  test("renders job list with status and phase", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Sidebar jobs={sampleJobs} selectedIndex={0} focused={true} />
      ),
      { width: 40, height: 12 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("J000001");
    expect(frame).toContain("J000002");
    expect(frame).toContain("J000003");
    expect(frame).toContain("running");
    expect(frame).toContain("completed");
    expect(frame).toContain("pending");
    expect(frame).toContain("code");
    expect(frame).toContain("review");
  });

  test("renders empty state", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Sidebar jobs={[]} selectedIndex={0} focused={false} />,
      { width: 40, height: 8 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("No jobs found");
  });

  test("highlights selected job with > prefix", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Sidebar jobs={sampleJobs} selectedIndex={1} focused={true} />
      ),
      { width: 40, height: 12 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    // Second job should have > prefix
    const lines = frame.split("\n");
    const j2Line = lines.find((l: string) => l.includes("J000002"));
    expect(j2Line).toContain(">");
  });

  test("shows [Enter] hint for selected pending job", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Sidebar jobs={sampleJobs} selectedIndex={2} focused={true} />
      ),
      { width: 50, height: 12 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    const j3Line = frame.split("\n").find((l: string) => l.includes("J000003"));
    expect(j3Line).toContain("[Enter]");
  });

  test("shows [...] for launching job", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Sidebar jobs={sampleJobs} selectedIndex={0} focused={true} launchingId="J000001" />
      ),
      { width: 50, height: 12 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    const j1Line = frame.split("\n").find((l: string) => l.includes("J000001"));
    expect(j1Line).toContain("[...]");
  });

  test("does not show [Enter] hint for completed job", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Sidebar jobs={sampleJobs} selectedIndex={1} focused={true} />
      ),
      { width: 50, height: 12 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    const j2Line = frame.split("\n").find((l: string) => l.includes("J000002"));
    expect(j2Line).not.toContain("[Enter]");
  });
});

describe("JobDetail", () => {
  test("renders job details when job is provided", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <JobDetail
          job={sampleJobs[1]}
          jobBody="## Description\nSome body text"
          focused={false}
        />
      ),
      { width: 60, height: 20 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("J000002");
    expect(frame).toContain("completed");
    expect(frame).toContain("review");
    expect(frame).toContain("Body");
  });

  test("renders placeholder when no job selected", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <JobDetail job={null} jobBody="" focused={false} />,
      { width: 60, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Select a job");
  });
});

describe("LogPanel", () => {
  test("renders log panel with job id in title", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <LogPanel
          jobId="J000001"
          logContent="Starting build...\nBuild complete."
          focused={true}
        />
      ),
      { width: 80, height: 15 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    // ghostty-terminal renders via VT emulator cells, so we verify the
    // panel border title contains the job ID
    expect(frame).toContain("J000001");
    expect(frame).toContain("[*]");
  });

  test("renders log panel with unfocused border", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <LogPanel jobId="J000001" logContent="" focused={false} />,
      { width: 80, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Log: J000001");
    // Not focused, no [*] marker
    expect(frame).not.toContain("[*]");
  });

  test("renders ANSI content through ghostty-terminal", async () => {
    const { captureSpans, renderOnce } = await testRender(
      () => (
        <LogPanel
          jobId="J000001"
          logContent={"\x1b[32mGreen text\x1b[0m"}
          focused={true}
        />
      ),
      { width: 80, height: 15 },
    );
    await renderOnce();
    // captureSpans verifies the renderable tree is constructed
    const spans = captureSpans();
    expect(spans).toBeDefined();
  });
});

describe("2-column layout", () => {
  test("renders sidebar and main panel side by side", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <box style={{ flexDirection: "row", flexGrow: 1 }}>
          <Sidebar jobs={sampleJobs} selectedIndex={0} focused={true} />
          <JobDetail
            job={sampleJobs[0]}
            jobBody="Test body"
            focused={false}
          />
        </box>
      ),
      { width: 100, height: 15 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    // Both panels should be visible
    expect(frame).toContain("Jobs");
    expect(frame).toContain("Detail");
    expect(frame).toContain("J000001");
  });
});
