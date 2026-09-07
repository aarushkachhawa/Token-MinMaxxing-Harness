import { ModelSelectionStore } from "./model-selection.js";

export type Provider = "anthropic" | "openai" | "google" | "ollama";

export interface CatalogModel {
  /** Raw model id as the provider's API expects it -- this is what a future ModelClientFactory
   * passes straight through, so it's kept provider-native (no synthetic "provider:name" prefix). */
  id: string;
  provider: Provider;
  /** Human-readable label shown in the /models list. */
  label: string;
  /** True for models that run on the user's own machine via Ollama instead of a cloud API. */
  local: boolean;
  /** Env var an api-key-based provider reads its credential from. Absent for local models. */
  apiKeyEnvVar?: string;
}

/**
 * The full set of models /models lets a user toggle on or off. Deliberately a fixed, curated
 * list rather than free-form entry -- "choose from a list of allowed models" is the point: a new
 * user starts with none enabled and opts into exactly the ones they have credentials or local
 * disk space for. For the Anthropic and Ollama entries below, this selection is the actual
 * allowlist the bandit's candidate arms are drawn from (see src/config/worker-models.ts and
 * cli.ts's onCategoryDiscovered) -- not just an additive "also consider these", so toggling a
 * model off actually removes it as something the router can pick, not merely deprioritizes it.
 * The OpenAI/Google entries still only drive the toggle UI and per-model setup (API key prompt) --
 * no ModelClient exists for either provider yet, so enabling one currently has no execution effect.
 */
export const MODEL_CATALOG: CatalogModel[] = [
  // Ollama (local) listed first -- checked/configured before any cloud provider, see runModelsCommand.
  { id: "qwen2.5-coder:7b", provider: "ollama", label: "Qwen2.5 Coder 7B", local: true },
  { id: "llama3.1:8b", provider: "ollama", label: "Llama 3.1 8B", local: true },
  { id: "deepseek-coder-v2:16b", provider: "ollama", label: "DeepSeek Coder V2 16B", local: true },
  { id: "qwen3:8b", provider: "ollama", label: "Qwen3 8B", local: true },

  { id: "claude-haiku-4-5-20251001", provider: "anthropic", label: "Claude Haiku 4.5", local: false, apiKeyEnvVar: "ANTHROPIC_API_KEY" },
  { id: "claude-sonnet-5", provider: "anthropic", label: "Claude Sonnet 5", local: false, apiKeyEnvVar: "ANTHROPIC_API_KEY" },
  { id: "claude-opus-5", provider: "anthropic", label: "Claude Opus 5", local: false, apiKeyEnvVar: "ANTHROPIC_API_KEY" },
  { id: "claude-fable-5-1", provider: "anthropic", label: "Claude Fable 5.1", local: false, apiKeyEnvVar: "ANTHROPIC_API_KEY" },

  { id: "gpt-4o", provider: "openai", label: "GPT-4o", local: false, apiKeyEnvVar: "OPENAI_API_KEY" },
  { id: "gpt-4o-mini", provider: "openai", label: "GPT-4o mini", local: false, apiKeyEnvVar: "OPENAI_API_KEY" },
  { id: "gpt-4.1", provider: "openai", label: "GPT-4.1", local: false, apiKeyEnvVar: "OPENAI_API_KEY" },

  // GOOGLE_GENERATIVE_AI_API_KEY matches @ai-sdk/google's default env var, for whenever the
  // execution side wires this provider up on the AI SDK the rest of this codebase already uses.
  { id: "gemini-2.5-pro", provider: "google", label: "Gemini 2.5 Pro", local: false, apiKeyEnvVar: "GOOGLE_GENERATIVE_AI_API_KEY" },
  { id: "gemini-2.5-flash", provider: "google", label: "Gemini 2.5 Flash", local: false, apiKeyEnvVar: "GOOGLE_GENERATIVE_AI_API_KEY" },
];

export function findCatalogModel(modelId: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((model) => model.id === modelId);
}

export function catalogModelsByProvider(provider: Provider): CatalogModel[] {
  return MODEL_CATALOG.filter((model) => model.provider === provider);
}

/**
 * Provider-native (unprefixed) ids of every catalog model of the given provider currently toggled
 * on via /models. Reads model-selection.json fresh on every call rather than taking a cached
 * ModelSelectionStore -- /models can change the file mid-session, and this is cheap enough (a
 * small JSON read) to just re-check instead of plumbing a shared mutable instance between the REPL
 * loop and the /models command.
 */
function enabledModelIdsByProvider(selectionPath: string, provider: Provider): string[] {
  const enabled = new Set(ModelSelectionStore.load(selectionPath).list());
  return catalogModelsByProvider(provider)
    .filter((model) => enabled.has(model.id))
    .map((model) => model.id);
}

/** The caller (cli.ts, via src/config/worker-models.ts) owns the "ollama:" prefix convention used
 * to route these through MultiProviderModelClientFactory -- that's an executor-layer concern this
 * config module doesn't need to know about. */
export function enabledOllamaModelIds(selectionPath: string): string[] {
  return enabledModelIdsByProvider(selectionPath, "ollama");
}

export function enabledAnthropicModelIds(selectionPath: string): string[] {
  return enabledModelIdsByProvider(selectionPath, "anthropic");
}
