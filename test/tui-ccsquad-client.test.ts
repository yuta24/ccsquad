import { describe, expect, test } from "bun:test";
import { parseDagStatusOutput, parseJobShowOutput } from "../src/tui/ccsquad-client.js";

describe("parseDagStatusOutput", () => {
  test("parses valid JSON array of jobs", () => {
    const input = JSON.stringify([
      {
        id: "J000001",
        title: "Test job",
        status: "running",
        current_phase: "code",
        iteration: 2,
        worktree_exists: true,
      },
      {
        id: "J000002",
        title: "Another job",
        status: "pending",
        current_phase: null,
        iteration: 0,
        worktree_exists: false,
      },
    ]);

    const result = parseDagStatusOutput(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "J000001",
      title: "Test job",
      status: "running",
      current_phase: "code",
      iteration: 2,
      worktree_exists: true,
    });
    expect(result[1]).toEqual({
      id: "J000002",
      title: "Another job",
      status: "pending",
      current_phase: null,
      iteration: 0,
      worktree_exists: false,
    });
  });

  test("returns empty array for empty string", () => {
    expect(parseDagStatusOutput("")).toEqual([]);
  });

  test("returns empty array for empty JSON array", () => {
    expect(parseDagStatusOutput("[]")).toEqual([]);
  });

  test("returns empty array for whitespace-only input", () => {
    expect(parseDagStatusOutput("   \n  ")).toEqual([]);
  });

  test("handles missing fields with defaults", () => {
    const input = JSON.stringify([{ id: "J000003" }]);
    const result = parseDagStatusOutput(input);
    expect(result[0]).toEqual({
      id: "J000003",
      title: "",
      status: "pending",
      current_phase: null,
      iteration: 0,
      worktree_exists: false,
    });
  });

  test("handles JSON with trailing newlines", () => {
    const input = JSON.stringify([
      { id: "J000001", title: "T", status: "completed", current_phase: "review", iteration: 3, worktree_exists: false },
    ]) + "\n";
    const result = parseDagStatusOutput(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("J000001");
    expect(result[0].status).toBe("completed");
  });
});

describe("parseJobShowOutput", () => {
  test("parses full job show JSON", () => {
    const input = JSON.stringify({
      id: "J000001",
      title: "Implement feature",
      status: "running",
      current_phase: "code",
      iteration: 2,
      max_iterations: 10,
      priority: 1,
      depends_on: ["J000000"],
      created_at: "2026-03-29T10:00:00Z",
      updated_at: "2026-03-29T12:00:00Z",
      body: "## Description\nSome work",
      phase_config: {
        type: "execute",
        agent: "developer",
        auto: false,
      },
    });

    const result = parseJobShowOutput(input);
    expect(result.id).toBe("J000001");
    expect(result.title).toBe("Implement feature");
    expect(result.status).toBe("running");
    expect(result.current_phase).toBe("code");
    expect(result.iteration).toBe(2);
    expect(result.max_iterations).toBe(10);
    expect(result.priority).toBe(1);
    expect(result.depends_on).toEqual(["J000000"]);
    expect(result.body).toBe("## Description\nSome work");
    expect(result.phase_config).toEqual({
      type: "execute",
      agent: "developer",
      auto: false,
    });
  });

  test("parses job without phase_config", () => {
    const input = JSON.stringify({
      id: "J000002",
      title: "Pending job",
      status: "pending",
      iteration: 0,
      max_iterations: 10,
      priority: 0,
      depends_on: [],
      created_at: "2026-03-29T10:00:00Z",
      updated_at: "2026-03-29T10:00:00Z",
      body: "## Description\nWork to do",
    });

    const result = parseJobShowOutput(input);
    expect(result.id).toBe("J000002");
    expect(result.current_phase).toBeUndefined();
    expect(result.phase_config).toBeUndefined();
  });

  test("handles missing optional fields", () => {
    const input = JSON.stringify({
      id: "J000003",
      title: "Minimal",
      status: "completed",
      body: "",
    });

    const result = parseJobShowOutput(input);
    expect(result.iteration).toBe(0);
    expect(result.max_iterations).toBe(10);
    expect(result.priority).toBe(0);
    expect(result.depends_on).toEqual([]);
    expect(result.body).toBe("");
  });
});
