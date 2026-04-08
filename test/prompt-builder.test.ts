import { describe, expect, test } from "bun:test";
import { buildJobPrompt } from "../src/app/prompt-builder.js";

describe("buildJobPrompt", () => {
  test("includes job ID in prompt", () => {
    const prompt = buildJobPrompt("J000042");
    expect(prompt).toContain("J000042");
  });

  test("includes ccsquad commands with job ID", () => {
    const prompt = buildJobPrompt("J000001");
    expect(prompt).toContain("ccsquad job show J000001 --format json");
    expect(prompt).toContain("ccsquad job transition J000001 completed");
    expect(prompt).toContain("ccsquad job transition J000001 failed");
  });

  test("includes review phase instruction", () => {
    const prompt = buildJobPrompt("J000001");
    expect(prompt).toContain("review");
  });
});
