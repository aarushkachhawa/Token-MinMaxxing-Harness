import { DEFAULT_DECAY, type Router } from "../router/bandit.js";
import type { ModelRegistry } from "./registry.js";

/**
 * Register one bandit arm per model for a task category, using the registry's per-token
 * rates against an assumed average token volume for that category as the arm's cost.
 * Safe to call repeatedly (e.g. on config reload): register() is idempotent and preserves
 * learned history for arms that already exist.
 */
export function seedRouterFromRegistry(
  router: Router,
  registry: ModelRegistry,
  category: string,
  modelIds: string[],
  avgInputTokens: number,
  avgOutputTokens: number,
  priorAlpha = 2,
  priorBeta = 1,
  decay: number = DEFAULT_DECAY
): void {
  for (const modelId of modelIds) {
    const cost = registry.estimateCost(modelId, avgInputTokens, avgOutputTokens);
    router.register(category, modelId, cost, priorAlpha, priorBeta, decay);
  }
}
