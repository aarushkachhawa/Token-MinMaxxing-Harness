import type { ModelConfig } from "./types.js";

export class ModelRegistry {
  private models = new Map<string, ModelConfig>();

  register(config: ModelConfig): void {
    if (this.models.has(config.modelId)) {
      throw new Error(`Model "${config.modelId}" is already registered`);
    }
    this.models.set(config.modelId, config);
  }

  get(modelId: string): ModelConfig {
    const config = this.models.get(modelId);
    if (!config) {
      throw new Error(`Unknown model "${modelId}"`);
    }
    return config;
  }

  list(): ModelConfig[] {
    return [...this.models.values()];
  }

  estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
    const config = this.get(modelId);
    return (
      (config.costPer1kInputTokens / 1000) * inputTokens +
      (config.costPer1kOutputTokens / 1000) * outputTokens
    );
  }
}
