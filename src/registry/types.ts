export interface ModelConfig {
  /** Unique key, e.g. "anthropic:claude-haiku-4-5" or "local:llama-3.1-8b". */
  modelId: string;
  /** Free-form so new backends don't require code changes: "anthropic", "openai", "local", ... */
  provider: string;
  costPer1kInputTokens: number;
  costPer1kOutputTokens: number;
  contextWindow: number;
  supportsTools: boolean;
  /** Optional human label for organizing the registry, e.g. "frontier" | "mid" | "local". Not enforced. */
  tier?: string;
}
