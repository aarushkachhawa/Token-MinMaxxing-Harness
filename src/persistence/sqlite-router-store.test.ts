import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArmState } from "../router/bandit.js";
import { SqliteRouterStore } from "./sqlite-router-store.js";

function armState(overrides: Partial<ArmState> & { category: string; modelId: string }): ArmState {
  return { cost: 0.01, priorAlpha: 2, priorBeta: 1, alpha: 2, beta: 1, decay: 0.995, ...overrides };
}

describe("SqliteRouterStore", () => {
  it("round-trips arm state through an in-memory database", () => {
    const store = new SqliteRouterStore(":memory:");
    const arms = [
      armState({ category: "small-edit", modelId: "cheap", alpha: 12.5, beta: 3.2 }),
      armState({ category: "small-edit", modelId: "strong", cost: 0.3, alpha: 40, beta: 1 }),
    ];

    store.save(arms);
    const loaded = store.load();

    expect(loaded).toHaveLength(2);
    expect(loaded).toContainEqual(arms[0]);
    expect(loaded).toContainEqual(arms[1]);
    store.close();
  });

  it("returns an empty array when nothing has been saved", () => {
    const store = new SqliteRouterStore(":memory:");
    expect(store.load()).toEqual([]);
    store.close();
  });

  it("upserts: saving the same (category, modelId) again updates rather than duplicates", () => {
    const store = new SqliteRouterStore(":memory:");
    store.save([armState({ category: "small-edit", modelId: "cheap", alpha: 5, beta: 2 })]);

    store.save([armState({ category: "small-edit", modelId: "cheap", alpha: 50, beta: 9 })]);

    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ alpha: 50, beta: 9 });
    store.close();
  });

  it("actually persists to disk: data survives closing and reopening a new store on the same file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sqlite-router-store-test-"));
    const dbPath = join(tempDir, "router.sqlite");
    try {
      const writer = new SqliteRouterStore(dbPath);
      writer.save([armState({ category: "small-edit", modelId: "cheap", alpha: 33, beta: 4 })]);
      writer.close();

      const reader = new SqliteRouterStore(dbPath);
      const loaded = reader.load();
      reader.close();

      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({ category: "small-edit", modelId: "cheap", alpha: 33, beta: 4 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
