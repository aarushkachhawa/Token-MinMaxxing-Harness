import type { ModelClient, ModelClientFactory } from "./types.js";

/** Prefix convention for a router decision.modelId that should resolve to a local Ollama model,
 * e.g. "ollama:llama3.1" -- everything else is assumed to be a (bare, unprefixed) Anthropic model
 * id, matching every arm registered before Ollama support existed. */
const OLLAMA_PREFIX = "ollama:";

export interface MultiProviderModelClientFactoryOptions {
  anthropic: ModelClientFactory;
  /** Omit when no OLLAMA_BASE_URL is configured -- an "ollama:"-prefixed modelId then fails
   * loudly at dispatch time instead of the harness silently never offering that arm. */
  ollama?: ModelClientFactory;
}

/**
 * Dispatches a router decision's modelId to the real provider-specific factory that can build a
 * client for it, keyed on the "ollama:" prefix convention above. This is the seam the
 * "Provider abstraction" open question in docs/architecture.md pointed at: SubtaskRunner already
 * only depends on the ModelClientFactory interface, so plugging this in instead of
 * AnthropicModelClientFactory directly is the entire change needed to make routing decisions span
 * providers.
 */
export class MultiProviderModelClientFactory implements ModelClientFactory {
  constructor(private options: MultiProviderModelClientFactoryOptions) {}

  getClient(modelId: string): ModelClient {
    if (modelId.startsWith(OLLAMA_PREFIX)) {
      if (!this.options.ollama) {
        throw new Error(
          `Model "${modelId}" needs an Ollama-backed factory, but none was configured ` +
            "(set OLLAMA_BASE_URL, or stop registering \"ollama:\"-prefixed arms)."
        );
      }
      return this.options.ollama.getClient(modelId.slice(OLLAMA_PREFIX.length));
    }
    return this.options.anthropic.getClient(modelId);
  }
}
