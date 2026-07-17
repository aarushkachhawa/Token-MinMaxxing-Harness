import { describe, expect, it } from "vitest";
import { ModelRegistry } from "./registry.js";
import type { ModelConfig } from "./types.js";

const haiku: ModelConfig = {
  modelId: "anthropic:haiku",
  provider: "anthropic",
  costPer1kInputTokens: 0.001,
  costPer1kOutputTokens: 0.005,
  contextWindow: 200_000,
  supportsTools: true,
  tier: "cheap",
};

const local: ModelConfig = {
  modelId: "local:llama-3.1-8b",
  provider: "local",
  costPer1kInputTokens: 0,
  costPer1kOutputTokens: 0,
  contextWindow: 128_000,
  supportsTools: false,
  tier: "local",
};

describe("ModelRegistry", () => {
  it("registers and retrieves a model config", () => {
    const registry = new ModelRegistry();
    registry.register(haiku);

    expect(registry.get("anthropic:haiku")).toEqual(haiku);
  });

  it("throws on duplicate registration", () => {
    const registry = new ModelRegistry();
    registry.register(haiku);

    expect(() => registry.register(haiku)).toThrow();
  });

  it("throws when looking up an unknown model", () => {
    const registry = new ModelRegistry();
    expect(() => registry.get("does-not-exist")).toThrow();
  });

  it("lists all registered configs", () => {
    const registry = new ModelRegistry();
    registry.register(haiku);
    registry.register(local);

    expect(registry.list()).toEqual([haiku, local]);
  });

  it("estimates cost from per-1k-token rates", () => {
    const registry = new ModelRegistry();
    registry.register(haiku);

    const cost = registry.estimateCost("anthropic:haiku", 2000, 500);

    expect(cost).toBeCloseTo(2 * 0.001 + 0.5 * 0.005, 10);
  });

  it("estimates zero cost for a free local model", () => {
    const registry = new ModelRegistry();
    registry.register(local);

    expect(registry.estimateCost("local:llama-3.1-8b", 5000, 2000)).toBe(0);
  });
});
