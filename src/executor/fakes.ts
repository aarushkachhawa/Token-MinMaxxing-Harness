import { z } from "zod";
import type { GenerateOptions, GenerateResult, ModelClient, ModelClientFactory, Tool } from "./types.js";

/** Returns a fixed, scripted sequence of responses — one per call to generate(). */
export class ScriptedModelClient implements ModelClient {
  private responses: GenerateResult[];
  private callCount = 0;
  /** Every options object the executor passed in, in call order — useful for asserting message flow. */
  receivedOptions: GenerateOptions[] = [];

  constructor(responses: GenerateResult[]) {
    this.responses = responses;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    this.receivedOptions.push(options);
    const response = this.responses[this.callCount];
    if (!response) {
      throw new Error(
        `ScriptedModelClient ran out of scripted responses after ${this.callCount} call(s)`
      );
    }
    this.callCount++;
    return response;
  }
}

/**
 * Returns a fixed client per modelId (falling back to a shared default for any modelId without
 * an override) -- lets a test either ignore which modelId got requested (the common case: just
 * pass one fallback client) or assert that different modelIds actually route to different
 * clients (the thing AnthropicModelClientFactory exists to guarantee for real).
 */
export class ScriptedModelClientFactory implements ModelClientFactory {
  /** Every modelId requested via getClient(), in call order. */
  requestedModelIds: string[] = [];

  constructor(
    private fallback: ModelClient,
    private overrides: Map<string, ModelClient> = new Map()
  ) {}

  getClient(modelId: string): ModelClient {
    this.requestedModelIds.push(modelId);
    return this.overrides.get(modelId) ?? this.fallback;
  }
}

export function fakeTool(
  name: string,
  execute: (args: Record<string, unknown>) => Promise<unknown> = async () => ({ ok: true })
): Tool {
  return {
    name,
    description: `fake tool "${name}"`,
    parameters: z.object({}),
    execute,
  };
}
