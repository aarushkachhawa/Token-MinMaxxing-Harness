import { describe, expect, it } from "vitest";
import { Router } from "./bandit.js";
import { SeededRng } from "./rng.js";

describe("Router", () => {
  it("routes to a registered model", () => {
    const router = new Router(new SeededRng(0));
    router.register("small-edit", "cheap", 0.01);
    router.register("small-edit", "strong", 0.3);

    const chosen = router.route("small-edit");

    expect(["cheap", "strong"]).toContain(chosen);
  });

  it("throws when routing an unknown category", () => {
    const router = new Router();
    expect(() => router.route("no-such-category")).toThrow();
  });

  it("updates only the reported arm", () => {
    const router = new Router();
    router.register("small-edit", "cheap", 0.01, 2, 1, 1); // decay=1: no forgetting, exact arithmetic

    router.reportOutcome("small-edit", "cheap", 1);
    router.reportOutcome("small-edit", "cheap", 0);

    const arm = router.getArm("small-edit", "cheap")!;
    expect(arm.alpha).toBe(3);
    expect(arm.beta).toBe(2);
  });

  it("register() is idempotent and preserves learned history", () => {
    const router = new Router();
    router.register("small-edit", "cheap", 0.01, 2, 1, 1);
    router.reportOutcome("small-edit", "cheap", 1);
    router.reportOutcome("small-edit", "cheap", 1);

    // re-registering (e.g. a config reload) should refresh cost but not wipe learned alpha/beta
    router.register("small-edit", "cheap", 0.02, 2, 1, 1);

    const arm = router.getArm("small-edit", "cheap")!;
    expect(arm.cost).toBe(0.02);
    expect(arm.alpha).toBe(4);
    expect(arm.beta).toBe(1);
  });

  it("resetArm() deliberately discards learned history", () => {
    const router = new Router();
    router.register("small-edit", "cheap", 0.01, 2, 1, 1);
    router.reportOutcome("small-edit", "cheap", 1);
    router.reportOutcome("small-edit", "cheap", 1);

    router.resetArm("small-edit", "cheap", 0.01, 2, 1, 1);

    const arm = router.getArm("small-edit", "cheap")!;
    expect(arm.alpha).toBe(2);
    expect(arm.beta).toBe(1);
  });

  it("accepts fractional rewards for blended success signals", () => {
    const router = new Router();
    router.register("small-edit", "cheap", 0.01, 2, 1, 1);

    router.reportOutcome("small-edit", "cheap", 0.7);

    const arm = router.getArm("small-edit", "cheap")!;
    expect(arm.alpha).toBeCloseTo(2.7, 10);
    expect(arm.beta).toBeCloseTo(1.3, 10);
  });

  it("rejects rewards outside [0, 1]", () => {
    const router = new Router();
    router.register("small-edit", "cheap", 0.01);
    expect(() => router.reportOutcome("small-edit", "cheap", 1.5)).toThrow();
    expect(() => router.reportOutcome("small-edit", "cheap", -0.1)).toThrow();
  });

  function simulate(
    router: Router,
    category: string,
    trueRates: Record<string, number>,
    rounds: number,
    envRng: SeededRng,
    costWeight = 0
  ): string[] {
    const choices: string[] = [];
    for (let i = 0; i < rounds; i++) {
      const modelId = router.route(category, costWeight);
      const reward = envRng.next() < trueRates[modelId] ? 1 : 0;
      router.reportOutcome(category, modelId, reward);
      choices.push(modelId);
    }
    return choices;
  }

  it("converges to the better model on quality alone", () => {
    const router = new Router(new SeededRng(42));
    router.register("small-edit", "cheap", 0.01);
    router.register("small-edit", "strong", 0.3);

    const trueRates = { cheap: 0.5, strong: 0.95 };
    const choices = simulate(router, "small-edit", trueRates, 3000, new SeededRng(7));

    const first300 = choices.slice(0, 300);
    expect(first300.filter((c) => c === "cheap").length).toBeGreaterThan(0);
    expect(first300.filter((c) => c === "strong").length).toBeGreaterThan(0);

    const last300 = choices.slice(-300);
    const strongCount = last300.filter((c) => c === "strong").length;
    const cheapCount = last300.filter((c) => c === "cheap").length;
    expect(strongCount).toBeGreaterThan(cheapCount);
    expect(strongCount / last300.length).toBeGreaterThan(0.85);
  });

  it("favors the cheaper model when quality is equal and cost is weighted", () => {
    const router = new Router(new SeededRng(1));
    router.register("small-edit", "cheap", 0.01);
    router.register("small-edit", "pricey", 1.0);

    const trueRates = { cheap: 0.9, pricey: 0.9 };
    const choices = simulate(router, "small-edit", trueRates, 500, new SeededRng(3), 0.5);

    const last100 = choices.slice(-100);
    const cheapCount = last100.filter((c) => c === "cheap").length;
    const priceyCount = last100.filter((c) => c === "pricey").length;
    expect(cheapCount).toBeGreaterThan(priceyCount);
  });

  it("cost weighting behaves consistently regardless of a category's absolute price scale", () => {
    // same 1:10 cost ratio, wildly different absolute scale — normalization should make
    // costWeight behave the same way in both, proving lambda isn't scale-dependent
    const cheapScale = new Router(new SeededRng(11));
    cheapScale.register("small-edit", "cheap", 0.001);
    cheapScale.register("small-edit", "pricey", 0.01);

    const expensiveScale = new Router(new SeededRng(11));
    expensiveScale.register("bulk-refactor", "cheap", 1000);
    expensiveScale.register("bulk-refactor", "pricey", 10000);

    const trueRates = { cheap: 0.9, pricey: 0.9 };
    const choicesA = simulate(cheapScale, "small-edit", trueRates, 500, new SeededRng(3), 0.5);
    const choicesB = simulate(
      expensiveScale,
      "bulk-refactor",
      trueRates,
      500,
      new SeededRng(3),
      0.5
    );

    const cheapShareA = choicesA.filter((c) => c === "cheap").length / choicesA.length;
    const cheapShareB = choicesB.filter((c) => c === "cheap").length / choicesB.length;

    expect(cheapShareA).toBeCloseTo(cheapShareB, 1);
  });

  it("adapts within a bounded number of pulls when a model's true success rate regresses", () => {
    // "strong" starts out excellent, then a provider-side regression drops it to near-useless.
    // A non-decaying bandit would take hundreds of failures to unlearn ~1000 prior successes;
    // this checks the router recovers within a bounded window instead.
    const router = new Router(new SeededRng(42));
    router.register("small-edit", "cheap", 0.01);
    router.register("small-edit", "strong", 0.3);

    const envRng = new SeededRng(7);
    // phase 1: let the router correctly learn "strong" is much better
    simulate(router, "small-edit", { cheap: 0.5, strong: 0.95 }, 1000, envRng);

    // phase 2: "strong" regresses hard; "cheap" is now relatively the better option
    const recoveryChoices = simulate(
      router,
      "small-edit",
      { cheap: 0.5, strong: 0.05 },
      600,
      envRng
    );

    const last200 = recoveryChoices.slice(-200);
    const cheapCount = last200.filter((c) => c === "cheap").length;
    expect(cheapCount / last200.length).toBeGreaterThan(0.8);
  });
});
