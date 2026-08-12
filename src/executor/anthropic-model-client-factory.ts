import { AnthropicModelClient } from "./anthropic-model-client.js";
import type { ModelClient, ModelClientFactory } from "./types.js";

export interface AnthropicModelClientFactoryOptions {
  apiKey: string;
}

/**
 * Real ModelClientFactory: turns a modelId string (e.g. "claude-haiku-4-5-20251001") into a
 * real, callable AnthropicModelClient. This is what actually makes the router's decision matter --
 * a bandit or escalation choice that only ever fed one fixed client would be routing in name only.
 *
 * Lazily constructs and caches one client per distinct modelId requested. AnthropicModelClient has
 * no per-call state, so reusing an instance across attempts for the same modelId is free and
 * avoids repeating createAnthropic() provider setup on every single subtask attempt.
 */
export class AnthropicModelClientFactory implements ModelClientFactory {
  private apiKey: string;
  private clients = new Map<string, ModelClient>();

  constructor(options: AnthropicModelClientFactoryOptions) {
    this.apiKey = options.apiKey;
  }

  getClient(modelId: string): ModelClient {
    let client = this.clients.get(modelId);
    if (!client) {
      client = new AnthropicModelClient({ apiKey: this.apiKey, modelId });
      this.clients.set(modelId, client);
    }
    return client;
  }
}
