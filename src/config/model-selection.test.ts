import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelSelectionStore } from "./model-selection.js";

describe("ModelSelectionStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tmh-model-selection-"));
    path = join(dir, "model-selection.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts with nothing enabled when no file exists yet", () => {
    const store = ModelSelectionStore.load(path);
    expect(store.list()).toEqual([]);
    expect(store.isEnabled("claude-sonnet-5")).toBe(false);
  });

  it("toggling a model on returns true and marks it enabled", () => {
    const store = ModelSelectionStore.load(path);
    expect(store.toggle("claude-sonnet-5")).toBe(true);
    expect(store.isEnabled("claude-sonnet-5")).toBe(true);
  });

  it("toggling an enabled model again returns false and disables it", () => {
    const store = ModelSelectionStore.load(path);
    store.toggle("claude-sonnet-5");
    expect(store.toggle("claude-sonnet-5")).toBe(false);
    expect(store.isEnabled("claude-sonnet-5")).toBe(false);
  });

  it("persists across a fresh load from the same path", () => {
    const store = ModelSelectionStore.load(path);
    store.toggle("claude-sonnet-5");
    store.toggle("qwen2.5-coder:7b");

    const reloaded = ModelSelectionStore.load(path);
    expect(reloaded.list().sort()).toEqual(["claude-sonnet-5", "qwen2.5-coder:7b"].sort());
  });

  it("creates missing parent directories on save", async () => {
    const nestedPath = join(dir, "nested", "dir", "model-selection.json");
    const store = ModelSelectionStore.load(nestedPath);
    store.toggle("claude-sonnet-5");

    const reloaded = ModelSelectionStore.load(nestedPath);
    expect(reloaded.isEnabled("claude-sonnet-5")).toBe(true);
  });
});
