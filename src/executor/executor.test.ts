import { describe, expect, it } from "vitest";
import { Executor } from "./executor.js";
import { fakeTool, ScriptedModelClient } from "./fakes.js";
import type { GenerateResult } from "./types.js";

function textResult(text: string, usage = { inputTokens: 10, outputTokens: 5 }): GenerateResult {
  return { toolCalls: [], text, usage };
}

function toolCallResult(
  calls: { id: string; toolName: string; args?: Record<string, unknown> }[],
  text: string | null = null,
  usage = { inputTokens: 10, outputTokens: 5 }
): GenerateResult {
  return {
    toolCalls: calls.map((c) => ({ id: c.id, toolName: c.toolName, args: c.args ?? {} })),
    text,
    usage,
  };
}

describe("Executor", () => {
  it("returns immediately when the first turn has no tool calls", async () => {
    const client = new ScriptedModelClient([textResult("done")]);
    const executor = new Executor(client, []);

    const result = await executor.run("system", "do the thing");

    expect(result.finalText).toBe("done");
    expect(result.turns).toBe(1);
    expect(result.toolCallCount).toBe(0);
    expect(result.stopReason).toBe("final_answer");
  });

  it("executes a tool call and feeds the result back before the final answer", async () => {
    const readFile = fakeTool("read_file", async (args) => ({ contents: `contents of ${args.path}` }));
    const client = new ScriptedModelClient([
      toolCallResult([{ id: "call-1", toolName: "read_file", args: { path: "a.txt" } }]),
      textResult("the file says hello"),
    ]);
    const executor = new Executor(client, [readFile]);

    const result = await executor.run("system", "read a.txt");

    expect(result.finalText).toBe("the file says hello");
    expect(result.turns).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.stopReason).toBe("final_answer");

    expect(result.trace).toEqual([
      { type: "tool_call", toolName: "read_file", args: { path: "a.txt" } },
      { type: "tool_result", toolName: "read_file", result: { contents: "contents of a.txt" } },
      { type: "assistant_text", text: "the file says hello" },
    ]);

    // the second call to the model must include the tool's result as a message
    const secondCallMessages = client.receivedOptions[1].messages;
    expect(secondCallMessages).toContainEqual({
      role: "tool",
      toolCallId: "call-1",
      toolName: "read_file",
      result: { contents: "contents of a.txt" },
    });
  });

  it("handles multiple tool calls within a single turn", async () => {
    const calls: string[] = [];
    const tool = fakeTool("t", async (args) => {
      calls.push(args.n as string);
      return { n: args.n };
    });
    const client = new ScriptedModelClient([
      toolCallResult([
        { id: "c1", toolName: "t", args: { n: "one" } },
        { id: "c2", toolName: "t", args: { n: "two" } },
      ]),
      textResult("done"),
    ]);
    const executor = new Executor(client, [tool]);

    const result = await executor.run("system", "go");

    expect(calls).toEqual(["one", "two"]);
    expect(result.toolCallCount).toBe(2);
  });

  it("reports an error for an unknown tool without crashing the loop", async () => {
    const client = new ScriptedModelClient([
      toolCallResult([{ id: "c1", toolName: "does_not_exist" }]),
      textResult("recovered"),
    ]);
    const executor = new Executor(client, []);

    const result = await executor.run("system", "go");

    expect(result.finalText).toBe("recovered");
    expect(result.trace).toContainEqual({
      type: "tool_error",
      toolName: "does_not_exist",
      error: 'Unknown tool "does_not_exist"',
    });
  });

  it("catches a tool execution error and feeds it back instead of throwing", async () => {
    const failingTool = fakeTool("flaky", async () => {
      throw new Error("boom");
    });
    const client = new ScriptedModelClient([
      toolCallResult([{ id: "c1", toolName: "flaky" }]),
      textResult("handled it"),
    ]);
    const executor = new Executor(client, [failingTool]);

    const result = await executor.run("system", "go");

    expect(result.finalText).toBe("handled it");
    expect(result.trace).toContainEqual({ type: "tool_error", toolName: "flaky", error: "boom" });
  });

  it("stops at maxTurns if the model never produces a final answer", async () => {
    const tool = fakeTool("t");
    const responses = Array.from({ length: 5 }, (_, i) =>
      toolCallResult([{ id: `c${i}`, toolName: "t" }])
    );
    const client = new ScriptedModelClient(responses);
    const executor = new Executor(client, [tool], { maxTurns: 5 });

    const result = await executor.run("system", "go");

    expect(result.stopReason).toBe("max_turns_exceeded");
    expect(result.turns).toBe(5);
    expect(result.toolCallCount).toBe(5);
    expect(result.finalText).toBe("");
  });

  it("accumulates token usage across every turn", async () => {
    const tool = fakeTool("t");
    const client = new ScriptedModelClient([
      toolCallResult([{ id: "c1", toolName: "t" }], null, { inputTokens: 100, outputTokens: 20 }),
      textResult("done", { inputTokens: 150, outputTokens: 10 }),
    ]);
    const executor = new Executor(client, [tool]);

    const result = await executor.run("system", "go");

    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 30 });
  });
});
