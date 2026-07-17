import { describe, expect, it } from "vitest";
import { Router } from "../router/bandit.js";
import { SeededRng } from "../router/rng.js";
import { ModelRegistry } from "./registry.js";
import { seedRouterFromRegistry } from "./seed-router.js";
import type { ModelConfig } from "./types.js";

const cheap: ModelConfig = {
  modelId: "local:llama",
  provider: "local",
  costPer1kInputTokens: 0,
  costPer1kOutputTokens: 0,
  contextWindow: 128_000,
  supportsTools: false,
};

const pricey: ModelConfig = {
  modelId: "anthropic:opus",
  provider: "anthropic",
  costPer1kInputTokens: 0.015,
  costPer1kOutputTokens: 0.075,
  contextWindow: 200_000,
  supportsTools: true,
};

describe("seedRouterFromRegistry", () => {
  it("registers one arm per model, with cost derived from the registry's rates", () => {
    const registry = new ModelRegistry();
    registry.register(cheap);
    registry.register(pricey);
    const router = new Router();

    seedRouterFromRegistry(router, registry, "small-edit", ["local:llama", "anthropic:opus"], 1000, 500);

    expect(router.getArm("small-edit", "local:llama")?.cost).toBe(0);
    expect(router.getArm("small-edit", "anthropic:opus")?.cost).toBeCloseTo(
      1 * 0.015 + 0.5 * 0.075,
      10
    );
  });

  it("wires up arms the bandit can actually route and learn over", () => {
    const registry = new ModelRegistry();
    registry.register(cheap);
    registry.register(pricey);
    const router = new Router(new SeededRng(5));

    seedRouterFromRegistry(router, registry, "small-edit", ["local:llama", "anthropic:opus"], 1000, 500);

    // equal-quality priors + real cost weighting should favor the free local model
    const envRng = new SeededRng(9);
    const choices: string[] = [];
    for (let i = 0; i < 300; i++) {
      const modelId = router.route("small-edit", 0.5);
      router.reportOutcome("small-edit", modelId, envRng.next() < 0.9 ? 1 : 0);
      choices.push(modelId);
    }

    const last50 = choices.slice(-50);
    expect(last50.filter((c) => c === "local:llama").length).toBeGreaterThan(
      last50.filter((c) => c === "anthropic:opus").length
    );
  });
});
