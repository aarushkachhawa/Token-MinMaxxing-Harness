import { describe, expect, it } from "vitest";
import type { ExecutionResult } from "../executor/types.js";
import { dampen, formatJudgePrompt } from "./anthropic-judge-client.js";
import type { JudgeRequest } from "./types.js";

describe("dampen", () => {
  it("leaves medium and high confidence scores untouched", () => {
    expect(dampen(0.9, "high")).toBe(0.9);
    expect(dampen(0.1, "medium")).toBe(0.1);
  });

  it("pulls low-confidence scores toward 0.5", () => {
    expect(dampen(1, "low")).toBeCloseTo(0.7, 10);
    expect(dampen(0, "low")).toBeCloseTo(0.3, 10);
  });

  it("leaves an already-neutral low-confidence score at 0.5", () => {
    expect(dampen(0.5, "low")).toBeCloseTo(0.5, 10);
  });
});

describe("formatJudgePrompt", () => {
  const baseResult: ExecutionResult = {
    finalText: "Fixed the off-by-one bug in the loop.",
    turns: 2,
    toolCallCount: 1,
    usage: { inputTokens: 100, outputTokens: 50 },
    stopReason: "final_answer",
    trace: [
      { type: "tool_call", toolName: "read_file", args: { path: "src/loop.ts" } },
      { type: "tool_result", toolName: "read_file", result: "for (let i = 0; i <= n; i++) {}" },
      { type: "assistant_text", text: "Found it." },
    ],
  };

  it("includes the task description, trace entries, and final output", () => {
    const request: JudgeRequest = { taskDescription: "fix the off-by-one bug", result: baseResult };
    const prompt = formatJudgePrompt(request);

    expect(prompt).toContain("fix the off-by-one bug");
    expect(prompt).toContain('[tool_call] read_file({"path":"src/loop.ts"})');
    expect(prompt).toContain('[tool_result] read_file -> "for (let i = 0; i <= n; i++) {}"');
    expect(prompt).toContain("[assistant] Found it.");
    expect(prompt).toContain("Fixed the off-by-one bug in the loop.");
    expect(prompt).toContain("Stop reason: final_answer");
  });

  it("renders a tool_error entry", () => {
    const result: ExecutionResult = {
      ...baseResult,
      trace: [{ type: "tool_error", toolName: "read_file", error: "ENOENT" }],
    };
    const prompt = formatJudgePrompt({ taskDescription: "x", result });

    expect(prompt).toContain("[tool_error] read_file: ENOENT");
  });

  it("handles an empty trace and empty final text without crashing", () => {
    const result: ExecutionResult = { ...baseResult, trace: [], finalText: "" };
    const prompt = formatJudgePrompt({ taskDescription: "x", result });

    expect(prompt).toContain("(no trace entries)");
    expect(prompt).toContain("(empty)");
  });
});
