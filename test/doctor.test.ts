import { describe, expect, test } from "bun:test";
import { buildDoctorReport } from "../src/app/doctor.js";
import { createTestContext } from "./helpers.js";

describe("buildDoctorReport", () => {
  test("reports project paths and agent handoff examples", () => {
    const ctx = createTestContext("ccsquad-doctor-test-");
    const report = buildDoctorReport(ctx);

    expect(report).toContain("ccsquad doctor");
    expect(report).toContain(ctx.projectRoot);
    expect(report).toContain("jobs_dir:");
    expect(report).toContain("claude -p");
    expect(report).toContain("codex exec");
    expect(report).toContain("Bash(ccsquad *)");
  });
});
