import { enabledAnthropicModelIds, enabledOllamaModelIds } from "./model-catalog.js";

/**
 * Bandit-facing modelId for every catalog model currently enabled via /models that this harness
 * actually knows how to execute as a subtask worker -- Anthropic (bare id) and Ollama
 * ("ollama:"-prefixed, matching MultiProviderModelClientFactory's dispatch convention) only, since
 * those are the only two ModelClient implementations that exist. An OpenAI/Google catalog entry
 * toggled on in /models is intentionally excluded here: registering it as a bandit arm would just
 * guarantee every pull on it fails, since nothing can execute it yet.
 *
 * This is the harness's allowlist, not an additive suggestion -- see cli.ts's onCategoryDiscovered,
 * which reconciles the bandit's registered arms against this set on every subtask (removing an arm
 * that's no longer enabled, not just leaving it un-refreshed) so a model toggled off in /models
 * actually stops being selectable, not merely deprioritized.
 */
export function enabledWorkerModelIds(selectionPath: string): string[] {
  return [
    ...enabledAnthropicModelIds(selectionPath),
    ...enabledOllamaModelIds(selectionPath).map((id) => `ollama:${id}`),
  ];
}

/** Rough relative cost weights for the bandit's cost-vs-quality tradeoff (CategoryRouter.select())
 * -- not real per-token pricing, just an ordering within a category. Only the two models this
 * harness has always used as workers have a considered weight; see DEFAULT_ANTHROPIC_MODEL_COST
 * for anything else the catalog might add. */
const ANTHROPIC_MODEL_COST: Record<string, number> = {
  "claude-haiku-4-5-20251001": 0.01,
  "claude-sonnet-5": 0.3,
  "claude-opus-5": 1,
};

/** Placeholder for an enabled Anthropic catalog model with no considered weight above (e.g.
 * Claude Fable 5.1, or a future catalog addition) -- a mid-tier guess, not real pricing. Real
 * fix is seeding bandit costs from ModelRegistry's per-token rates instead of this hand-maintained
 * map (see docs/architecture.md's "Provider abstraction" open design question). */
const DEFAULT_ANTHROPIC_MODEL_COST = 0.3;

export function costForWorkerModelId(modelId: string): number {
  if (modelId.startsWith("ollama:")) return 0; // runs on the user's own machine
  return ANTHROPIC_MODEL_COST[modelId] ?? DEFAULT_ANTHROPIC_MODEL_COST;
}
