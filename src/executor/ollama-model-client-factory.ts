import { OllamaModelClient } from "./ollama-model-client.js";
import type { ModelClient, ModelClientFactory } from "./types.js";

export interface OllamaModelClientFactoryOptions {
  /** Ollama's OpenAI-compatible endpoint, e.g. "http://localhost:11434/v1". */
  baseUrl: string;
}

/** Mirrors AnthropicModelClientFactory: lazily builds and caches one OllamaModelClient per
 * distinct modelId (e.g. "llama3.1") requested. */
export class OllamaModelClientFactory implements ModelClientFactory {
  private baseUrl: string;
  private clients = new Map<string, ModelClient>();

  constructor(options: OllamaModelClientFactoryOptions) {
    this.baseUrl = options.baseUrl;
  }

  getClient(modelId: string): ModelClient {
    let client = this.clients.get(modelId);
    if (!client) {
      client = new OllamaModelClient({ baseUrl: this.baseUrl, modelId });
      this.clients.set(modelId, client);
    }
    return client;
  }
}
