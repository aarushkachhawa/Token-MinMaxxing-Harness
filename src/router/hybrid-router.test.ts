import { describe, expect, it } from "vitest";
import { Router } from "./bandit.js";
import { ScriptedEscalationClient } from "./escalation.js";
import { HybridRouter } from "./hybrid-router.js";
import { SeededRng } from "./rng.js";

describe("HybridRouter", () => {
  it("escalates a cold category instead of using the bandit", async () => {
    const bandit = new Router(new SeededRng(1));
    bandit.register("small-edit", "cheap", 0.01);
    bandit.register("small-edit", "strong", 0.3);
    const escalation = new ScriptedEscalationClient(["strong"]);
    const router = new HybridRouter(bandit, escalation);

    const decision = await router.route("small-edit", "fix the off-by-one in the loop");

    expect(decision).toEqual({ modelId: "strong", escalated: true });
    expect(escalation.receivedRequests).toHaveLength(1);
    expect(escalation.receivedRequests[0].taskDescription).toBe("fix the off-by-one in the loop");
    expect(escalation.receivedRequests[0].candidates.map((c) => c.modelId).sort()).toEqual([
      "cheap",
      "strong",
    ]);
  });

  it("uses the bandit once a category has enough evidence, without calling escalation", async () => {
    const bandit = new Router(new SeededRng(1));
    bandit.register("small-edit", "cheap", 0.01);
    bandit.register("small-edit", "strong", 0.3);
    for (let i = 0; i < 10; i++) {
      bandit.reportOutcome("small-edit", "cheap", 1);
      bandit.reportOutcome("small-edit", "strong", 1);
    }
    const escalation = new ScriptedEscalationClient([]);
    const router = new HybridRouter(bandit, escalation, { minPullsBeforeConfident: 5 });

    const decision = await router.route("small-edit", "fix a typo");

    expect(decision.escalated).toBe(false);
    expect(["cheap", "strong"]).toContain(decision.modelId);
    expect(escalation.receivedRequests).toHaveLength(0);
  });

  it("escalates a warm category anyway when forceEscalate is set", async () => {
    const bandit = new Router(new SeededRng(1));
    bandit.register("small-edit", "cheap", 0.01);
    bandit.register("small-edit", "strong", 0.3);
    for (let i = 0; i < 10; i++) {
      bandit.reportOutcome("small-edit", "cheap", 1);
      bandit.reportOutcome("small-edit", "strong", 1);
    }
    const escalation = new ScriptedEscalationClient(["strong"]);
    const router = new HybridRouter(bandit, escalation, { minPullsBeforeConfident: 5 });

    const decision = await router.route("small-edit", "touches the auth module", {
      forceEscalate: true,
    });

    expect(decision).toEqual({ modelId: "strong", escalated: true });
    expect(escalation.receivedRequests).toHaveLength(1);
  });

  it("rejects an escalation choice that isn't a registered candidate", async () => {
    const bandit = new Router();
    bandit.register("small-edit", "cheap", 0.01);
    const escalation = new ScriptedEscalationClient(["made-up-model"]);
    const router = new HybridRouter(bandit, escalation);

    await expect(router.route("small-edit", "task")).rejects.toThrow(/unregistered model/);
  });

  it("throws on an unknown category", async () => {
    const router = new HybridRouter(new Router(), new ScriptedEscalationClient([]));
    await expect(router.route("no-such-category", "task")).rejects.toThrow();
  });

  it("delegates register/resetArm/reportOutcome to the underlying bandit", async () => {
    const bandit = new Router();
    const router = new HybridRouter(bandit, new ScriptedEscalationClient([]));

    router.register("small-edit", "cheap", 0.01, 2, 1, 1);
    router.reportOutcome("small-edit", "cheap", 1);
    expect(bandit.getArm("small-edit", "cheap")?.alpha).toBe(3);

    router.resetArm("small-edit", "cheap", 0.01, 2, 1, 1);
    expect(bandit.getArm("small-edit", "cheap")?.alpha).toBe(2);
  });
});
