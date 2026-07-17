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
    router.register("small-edit", "cheap", 0.01, 2, 1);

    router.reportOutcome("small-edit", "cheap", true);
    router.reportOutcome("small-edit", "cheap", false);

    const arm = router.getArm("small-edit", "cheap")!;
    expect(arm.alpha).toBe(3);
    expect(arm.beta).toBe(2);
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
      const success = envRng.next() < trueRates[modelId];
      router.reportOutcome(category, modelId, success);
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
    expect(strongCount / last300.length).toBeGreaterThan(0.9);
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
});
