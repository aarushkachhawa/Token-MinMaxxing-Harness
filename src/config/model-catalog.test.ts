import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enabledOllamaModelIds, MODEL_CATALOG } from "./model-catalog.js";
import { ModelSelectionStore } from "./model-selection.js";

describe("enabledOllamaModelIds", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tmh-model-catalog-"));
    path = join(dir, "model-selection.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns nothing when no selection file exists yet", () => {
    expect(enabledOllamaModelIds(path)).toEqual([]);
  });

  it("returns only the ollama ids that are both enabled and in the catalog", () => {
    const store = ModelSelectionStore.load(path);
    store.toggle("qwen3:8b"); // ollama, in catalog
    store.toggle("claude-sonnet-5"); // anthropic, in catalog -- must be excluded
    store.toggle("some-model-nobody-curated"); // not in catalog at all -- must be excluded

    expect(enabledOllamaModelIds(path)).toEqual(["qwen3:8b"]);
  });

  it("reflects a toggle made after the first read (no caching)", () => {
    const store = ModelSelectionStore.load(path);
    expect(enabledOllamaModelIds(path)).toEqual([]);

    store.toggle("llama3.1:8b");
    expect(enabledOllamaModelIds(path)).toEqual(["llama3.1:8b"]);
  });

  it("qwen3:8b is a real catalog entry", () => {
    expect(MODEL_CATALOG.some((m) => m.id === "qwen3:8b" && m.provider === "ollama")).toBe(true);
  });
});
