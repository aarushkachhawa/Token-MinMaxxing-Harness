import { describe, expect, it } from "vitest";
import { ScriptedModelClient, ScriptedModelClientFactory } from "./fakes.js";
import { MultiProviderModelClientFactory } from "./multi-provider-model-client-factory.js";

describe("MultiProviderModelClientFactory", () => {
  it("strips the ollama: prefix and dispatches to the ollama factory", () => {
    const anthropic = new ScriptedModelClientFactory(new ScriptedModelClient([]));
    const ollama = new ScriptedModelClientFactory(new ScriptedModelClient([]));
    const factory = new MultiProviderModelClientFactory({ anthropic, ollama });

    factory.getClient("ollama:llama3.2");

    expect(ollama.requestedModelIds).toEqual(["llama3.2"]);
    expect(anthropic.requestedModelIds).toEqual([]);
  });

  it("dispatches a bare (unprefixed) modelId to the anthropic factory", () => {
    const anthropic = new ScriptedModelClientFactory(new ScriptedModelClient([]));
    const ollama = new ScriptedModelClientFactory(new ScriptedModelClient([]));
    const factory = new MultiProviderModelClientFactory({ anthropic, ollama });

    factory.getClient("claude-haiku-4-5-20251001");

    expect(anthropic.requestedModelIds).toEqual(["claude-haiku-4-5-20251001"]);
    expect(ollama.requestedModelIds).toEqual([]);
  });

  it("throws a clear error for an ollama: modelId when no ollama factory was configured", () => {
    const anthropic = new ScriptedModelClientFactory(new ScriptedModelClient([]));
    const factory = new MultiProviderModelClientFactory({ anthropic });

    expect(() => factory.getClient("ollama:llama3.2")).toThrow(/Ollama/);
  });
});
