import { describe, expect, it } from "vitest";
import type { ExecutionResult } from "../executor/types.js";
import { finishedCleanly, noToolErrors, producedOutput } from "./proxy-signals.js";

function makeResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    finalText: "done",
    turns: 1,
    toolCallCount: 0,
    usage: { inputTokens: 10, outputTokens: 5 },
    trace: [],
    stopReason: "final_answer",
    ...overrides,
  };
}

describe("finishedCleanly", () => {
  it("scores 1 when the run ended with a final answer", () => {
    expect(finishedCleanly.compute(makeResult({ stopReason: "final_answer" }))).toBe(1);
  });

  it("scores 0 when the run hit maxTurns", () => {
    expect(finishedCleanly.compute(makeResult({ stopReason: "max_turns_exceeded" }))).toBe(0);
  });
});

describe("noToolErrors", () => {
  it("scores 1 when no tools were called at all", () => {
    expect(noToolErrors.compute(makeResult({ trace: [] }))).toBe(1);
  });

  it("scores 1 when every tool call succeeded", () => {
    const trace: ExecutionResult["trace"] = [
      { type: "tool_call", toolName: "read", args: {} },
      { type: "tool_result", toolName: "read", result: {} },
    ];
    expect(noToolErrors.compute(makeResult({ trace }))).toBe(1);
  });

  it("scores proportionally to the fraction of failed tool calls", () => {
    const trace: ExecutionResult["trace"] = [
      { type: "tool_call", toolName: "read", args: {} },
      { type: "tool_error", toolName: "read", error: "boom" },
      { type: "tool_call", toolName: "write", args: {} },
      { type: "tool_result", toolName: "write", result: {} },
    ];
    expect(noToolErrors.compute(makeResult({ trace }))).toBe(0.5);
  });
});

describe("producedOutput", () => {
  it("scores 1 for non-empty final text", () => {
    expect(producedOutput.compute(makeResult({ finalText: "here you go" }))).toBe(1);
  });

  it("scores 0 for empty or whitespace-only final text", () => {
    expect(producedOutput.compute(makeResult({ finalText: "" }))).toBe(0);
    expect(producedOutput.compute(makeResult({ finalText: "   " }))).toBe(0);
  });
});
