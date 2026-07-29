import { describe, expect, it } from "vitest";
import type { Subtask } from "../orchestrator/types.js";
import { ContextCompiler } from "./context-compiler.js";
import type { SubtaskOutput } from "./types.js";

function subtask(overrides: Partial<Subtask> & { id: string }): Subtask {
  return { description: `do ${overrides.id}`, dependsOn: [], highRisk: false, ...overrides };
}

function output(overrides: Partial<SubtaskOutput> & { subtaskId: string }): SubtaskOutput {
  return { description: `do ${overrides.subtaskId}`, finalText: "done", ...overrides };
}

describe("ContextCompiler.compilePrompt", () => {
  it("returns just the description when there are no dependencies", () => {
    const compiler = new ContextCompiler();
    const result = compiler.compilePrompt(subtask({ id: "a", description: "do the thing" }), new Map());
    expect(result).toBe("do the thing");
  });

  it("includes a single dependency's description and output", () => {
    const compiler = new ContextCompiler();
    const priorOutputs = new Map([
      ["investigate", output({ subtaskId: "investigate", description: "find the bug", finalText: "it's on line 42" })],
    ]);

    const result = compiler.compilePrompt(
      subtask({ id: "fix", description: "fix the bug", dependsOn: ["investigate"] }),
      priorOutputs
    );

    expect(result).toBe(
      "Prior work this task depends on:\n\n" +
        "[investigate] find the bug\n> it's on line 42\n\n" +
        "---\n\n" +
        "Your task: fix the bug"
    );
  });

  it("includes multiple dependencies in dependsOn order", () => {
    const compiler = new ContextCompiler();
    const priorOutputs = new Map([
      ["a", output({ subtaskId: "a", description: "task a", finalText: "output a" })],
      ["b", output({ subtaskId: "b", description: "task b", finalText: "output b" })],
    ]);

    const result = compiler.compilePrompt(
      subtask({ id: "c", description: "task c", dependsOn: ["a", "b"] }),
      priorOutputs
    );

    expect(result).toContain("[a] task a\n> output a");
    expect(result).toContain("[b] task b\n> output b");
    expect(result.indexOf("[a]")).toBeLessThan(result.indexOf("[b]"));
  });

  it("only includes outputs the subtask actually depends on, not everything recorded", () => {
    const compiler = new ContextCompiler();
    const priorOutputs = new Map([
      ["a", output({ subtaskId: "a", finalText: "relevant" })],
      ["unrelated", output({ subtaskId: "unrelated", finalText: "should not appear" })],
    ]);

    const result = compiler.compilePrompt(subtask({ id: "b", dependsOn: ["a"] }), priorOutputs);

    expect(result).toContain("relevant");
    expect(result).not.toContain("should not appear");
  });

  it("throws if a dependency's output hasn't been recorded yet", () => {
    const compiler = new ContextCompiler();
    expect(() =>
      compiler.compilePrompt(subtask({ id: "b", dependsOn: ["a"] }), new Map())
    ).toThrow(/no output is recorded/);
  });

  it("truncates a dependency's output past the configured cap", () => {
    const compiler = new ContextCompiler({ maxCharsPerDependency: 10 });
    const priorOutputs = new Map([
      ["a", output({ subtaskId: "a", finalText: "0123456789ABCDEF" })],
    ]);

    const result = compiler.compilePrompt(subtask({ id: "b", dependsOn: ["a"] }), priorOutputs);

    expect(result).toContain("> 0123456789\n[truncated]");
    expect(result).not.toContain("ABCDEF");
  });

  it("does not truncate output at or under the cap", () => {
    const compiler = new ContextCompiler({ maxCharsPerDependency: 10 });
    const priorOutputs = new Map([["a", output({ subtaskId: "a", finalText: "0123456789" })]]);

    const result = compiler.compilePrompt(subtask({ id: "b", dependsOn: ["a"] }), priorOutputs);

    expect(result).toContain("> 0123456789\n\n---");
    expect(result).not.toContain("[truncated]");
  });
});
