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
 * disk space for. Execution wiring (actually routing requests to whichever of these are enabled)
 * is being built on a separate branch -- this catalog only drives the toggle UI and per-model
 * setup (API key prompt / Ollama download prompt) for now.
 */
export const MODEL_CATALOG: CatalogModel[] = [
  // Ollama (local) listed first -- checked/configured before any cloud provider, see runModelsCommand.
  { id: "qwen2.5-coder:7b", provider: "ollama", label: "Qwen2.5 Coder 7B", local: true },
  { id: "llama3.1:8b", provider: "ollama", label: "Llama 3.1 8B", local: true },
  { id: "deepseek-coder-v2:16b", provider: "ollama", label: "DeepSeek Coder V2 16B", local: true },

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
