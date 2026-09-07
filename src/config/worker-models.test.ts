import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelSelectionStore } from "./model-selection.js";
import { costForWorkerModelId, enabledWorkerModelIds } from "./worker-models.js";

describe("enabledWorkerModelIds", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tmh-worker-models-"));
    path = join(dir, "model-selection.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns nothing when nothing is enabled -- no default fallback", () => {
    expect(enabledWorkerModelIds(path)).toEqual([]);
  });

  it("returns a bare id for an enabled Anthropic model and an ollama:-prefixed id for Ollama", () => {
    const store = ModelSelectionStore.load(path);
    store.toggle("claude-sonnet-5");
    store.toggle("qwen3:8b");

    expect(enabledWorkerModelIds(path).sort()).toEqual(["claude-sonnet-5", "ollama:qwen3:8b"].sort());
  });

  it("excludes an enabled model from a provider with no execution support (e.g. OpenAI)", () => {
    const store = ModelSelectionStore.load(path);
    store.toggle("gpt-4o");
    store.toggle("claude-haiku-4-5-20251001");

    expect(enabledWorkerModelIds(path)).toEqual(["claude-haiku-4-5-20251001"]);
  });

  it("only enabled models are ever returned -- disabling one removes it", () => {
    const store = ModelSelectionStore.load(path);
    store.toggle("claude-haiku-4-5-20251001");
    store.toggle("claude-sonnet-5");
    expect(enabledWorkerModelIds(path).sort()).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-5"].sort());

    store.toggle("claude-sonnet-5"); // disable it again
    expect(enabledWorkerModelIds(path)).toEqual(["claude-haiku-4-5-20251001"]);
  });
});

describe("costForWorkerModelId", () => {
  it("is always 0 for an ollama:-prefixed model", () => {
    expect(costForWorkerModelId("ollama:qwen3:8b")).toBe(0);
    expect(costForWorkerModelId("ollama:anything-at-all")).toBe(0);
  });

  it("uses the known weight for the two established Anthropic worker tiers", () => {
    expect(costForWorkerModelId("claude-haiku-4-5-20251001")).toBeLessThan(
      costForWorkerModelId("claude-sonnet-5")
    );
  });

  it("falls back to a default for an Anthropic model with no considered weight", () => {
    expect(costForWorkerModelId("claude-fable-5-1")).toBeGreaterThan(0);
  });
});
