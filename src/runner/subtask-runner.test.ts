import { describe, expect, it } from "vitest";
import { TaskClassifier } from "../classifier/task-classifier.js";
import { ContextCompiler } from "../context/context-compiler.js";
import type { SubtaskOutput } from "../context/types.js";
import { fakeTool, ScriptedModelClient } from "../executor/fakes.js";
import type { GenerateResult } from "../executor/types.js";
import type { Subtask } from "../orchestrator/types.js";
import { RewardCollector } from "../reward/reward-collector.js";
import { Router } from "../router/bandit.js";
import { ScriptedEscalationClient } from "../router/escalation.js";
import { SubtaskRunner } from "./subtask-runner.js";

function subtask(overrides: Partial<Subtask> & { id: string }): Subtask {
  return { description: "do the task", dependsOn: [], highRisk: false, ...overrides };
}

function textResult(text: string): GenerateResult {
  return { toolCalls: [], text, usage: { inputTokens: 10, outputTokens: 5 } };
}

function toolCallResult(toolName: string): GenerateResult {
  return {
    toolCalls: [{ id: "c1", toolName, args: {} }],
    text: null,
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

const CATEGORY = "work";

function makeRunner(
  client: ScriptedModelClient,
  bandit: Router,
  escalationChoice = "strong"
): SubtaskRunner {
  const classifier = new TaskClassifier({ rules: [{ category: CATEGORY, keywords: ["task"] }] });
  const goodTool = fakeTool("good_tool", async () => ({ ok: true }));
  return new SubtaskRunner(
    bandit,
    classifier,
    new RewardCollector(),
    client,
    [goodTool],
    new ContextCompiler(),
    new ScriptedEscalationClient([escalationChoice]),
    {
      executorMaxTurns: 1,
      hybridRouterOptions: { minPullsBeforeConfident: 0 }, // isolate forceEscalate as the only escalation trigger
      onCategoryDiscovered: (category) => {
        if (bandit.getCandidates(category).length === 0) {
          bandit.register(category, "fast", 0.01);
          bandit.register(category, "strong", 0.3);
        }
      },
    }
  );
}

describe("SubtaskRunner", () => {
  it("returns the first attempt's result when it succeeds, without retrying", async () => {
    const client = new ScriptedModelClient([textResult("all done")]);
    const bandit = new Router();
    const runner = makeRunner(client, bandit);

    const result = await runner.run(subtask({ id: "a" }), new Map());

    expect(result.escalatedAfterFailure).toBe(false);
    expect(result.output).toEqual({ subtaskId: "a", description: "do the task", finalText: "all done" });
    expect(result.reward).toBe(1); // clean success on all default proxy signals
  });

  it("retries with forced escalation when the first attempt hits maxTurns, and uses the better retry", async () => {
    const client = new ScriptedModelClient([
      toolCallResult("good_tool"), // attempt 1: hits maxTurns=1, never finishes
      textResult("fixed on retry"), // attempt 2 (escalated): succeeds immediately
    ]);
    const bandit = new Router();
    const runner = makeRunner(client, bandit);

    const result = await runner.run(subtask({ id: "a" }), new Map());

    expect(result.escalatedAfterFailure).toBe(true);
    expect(result.output.finalText).toBe("fixed on retry");
    expect(result.reward).toBe(1);
  });

  it("keeps the first attempt's output if the escalated retry is actually worse", async () => {
    const client = new ScriptedModelClient([
      toolCallResult("good_tool"), // attempt 1: hits maxTurns, but its one tool call succeeded
      toolCallResult("missing_tool"), // attempt 2 (escalated): hits maxTurns AND errors on an unknown tool
    ]);
    const bandit = new Router();
    const runner = makeRunner(client, bandit);

    const result = await runner.run(subtask({ id: "a" }), new Map());

    expect(result.escalatedAfterFailure).toBe(true);
    // both attempts hit maxTurns (finalText === ""), so the tiebreak is which had fewer tool errors
    expect(result.output.finalText).toBe("");
    expect(result.reward).toBeGreaterThan(0); // attempt 1's reward (successful tool call), not attempt 2's (0)
  });

  it("reports both attempts' outcomes to the bandit, even though only one output is kept", async () => {
    const client = new ScriptedModelClient([toolCallResult("good_tool"), textResult("fixed")]);
    const bandit = new Router();
    // pre-register (rather than relying on onCategoryDiscovered) so a "before" snapshot exists
    bandit.register(CATEGORY, "fast", 0.01);
    bandit.register(CATEGORY, "strong", 0.3);
    const runner = makeRunner(client, bandit);

    // attempt 1 picks between "fast"/"strong" via plain (unseeded) Thompson sampling from
    // identical fresh priors, so it may land on either one -- don't assume which. What must be
    // true regardless is that two real updates happened somewhere: each arm starts at a fixed
    // (2,1) prior (sum 3), and every update strictly increases whichever arm it hits, so the
    // combined total across both arms rising by more than one update's worth proves two
    // outcomes were reported, without caring how they were distributed between the two arms.
    const sum = () =>
      bandit.getArm(CATEGORY, "fast")!.alpha +
      bandit.getArm(CATEGORY, "fast")!.beta +
      bandit.getArm(CATEGORY, "strong")!.alpha +
      bandit.getArm(CATEGORY, "strong")!.beta;
    const before = sum();

    await runner.run(subtask({ id: "a" }), new Map());

    expect(sum()).toBeGreaterThan(before + 1);
  });

  it("compiles prior dependency output into the prompt actually sent to the model", async () => {
    const client = new ScriptedModelClient([textResult("done")]);
    const bandit = new Router();
    const runner = makeRunner(client, bandit);
    const priorOutputs = new Map<string, SubtaskOutput>([
      ["dep", { subtaskId: "dep", description: "earlier task", finalText: "earlier result" }],
    ]);

    await runner.run(subtask({ id: "a", dependsOn: ["dep"] }), priorOutputs);

    const sentMessages = client.receivedOptions[0].messages;
    expect(sentMessages[0]).toEqual({
      role: "user",
      content: expect.stringContaining("earlier result"),
    });
  });

  it("calls onCategoryDiscovered exactly once per run, not once per attempt", async () => {
    const client = new ScriptedModelClient([toolCallResult("good_tool"), textResult("fixed")]);
    const bandit = new Router();
    let calls = 0;
    const classifier = new TaskClassifier({ rules: [{ category: CATEGORY, keywords: ["task"] }] });
    const runner = new SubtaskRunner(
      bandit,
      classifier,
      new RewardCollector(),
      client,
      [fakeTool("good_tool", async () => ({ ok: true }))],
      new ContextCompiler(),
      new ScriptedEscalationClient(["strong"]),
      {
        executorMaxTurns: 1,
        hybridRouterOptions: { minPullsBeforeConfident: 0 },
        onCategoryDiscovered: () => {
          calls++;
          if (bandit.getCandidates(CATEGORY).length === 0) {
            bandit.register(CATEGORY, "fast", 0.01);
            bandit.register(CATEGORY, "strong", 0.3);
          }
        },
      }
    );

    await runner.run(subtask({ id: "a" }), new Map());

    expect(calls).toBe(1);
  });
});
