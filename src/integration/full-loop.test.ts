import { describe, expect, it } from "vitest";
import { Executor } from "../executor/executor.js";
import { fakeTool, ScriptedModelClient } from "../executor/fakes.js";
import { RewardCollector } from "../reward/reward-collector.js";
import { Router } from "../router/bandit.js";
import { SeededRng } from "../router/rng.js";

describe("full loop: router -> executor -> reward collector -> router", () => {
  it("wires a routed model's execution result back into the router's learned stats", async () => {
    const router = new Router(new SeededRng(1));
    router.register("small-edit", "cheap", 0.01);
    router.register("small-edit", "strong", 0.3);

    // 1. router picks a model for this task's category
    const modelId = router.route("small-edit");

    // 2. executor runs that model against a task, using a scripted client since no real
    //    provider is wired up yet
    const readFile = fakeTool("read_file", async () => ({ contents: "the bug is on line 3" }));
    const client = new ScriptedModelClient([
      { toolCalls: [{ id: "c1", toolName: "read_file", args: { path: "a.ts" } }], text: null, usage: { inputTokens: 50, outputTokens: 10 } },
      { toolCalls: [], text: "fixed the off-by-one on line 3", usage: { inputTokens: 60, outputTokens: 15 } },
    ]);
    const executor = new Executor(client, [readFile]);
    const result = await executor.run("system prompt", "fix the bug in a.ts");

    expect(result.stopReason).toBe("final_answer");

    // 3. reward collector grades the execution result
    const rewardCollector = new RewardCollector();
    const breakdown = await rewardCollector.score("fix the bug in a.ts", result);

    // clean run, no tool errors, produced output -> every default proxy signal scores 1
    expect(breakdown.reward).toBe(1);

    // 4. that reward feeds back into the router for the model it actually picked
    router.reportOutcome("small-edit", modelId, breakdown.reward);

    const arm = router.getArm("small-edit", modelId)!;
    expect(arm.alpha).toBeGreaterThan(2); // moved up from its prior after a reward of 1
  });
});
