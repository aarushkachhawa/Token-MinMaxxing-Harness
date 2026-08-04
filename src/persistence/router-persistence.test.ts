import { describe, expect, it } from "vitest";
import { Router } from "../router/bandit.js";
import { SeededRng } from "../router/rng.js";
import { loadRouterState, saveRouterState } from "./router-persistence.js";
import { SqliteRouterStore } from "./sqlite-router-store.js";

describe("saveRouterState / loadRouterState", () => {
  it("round-trips a router's learned state through a store with no change in behavior", () => {
    const store = new SqliteRouterStore(":memory:");
    const original = new Router(new SeededRng(42));
    original.register("small-edit", "cheap", 0.01);
    original.register("small-edit", "strong", 0.3);
    for (let i = 0; i < 50; i++) {
      original.reportOutcome("small-edit", "strong", 0.9);
      original.reportOutcome("small-edit", "cheap", 0.4);
    }

    saveRouterState(original, store);
    const restored = loadRouterState(store, new SeededRng(1));

    expect(restored.getArm("small-edit", "cheap")).toEqual(original.getArm("small-edit", "cheap"));
    expect(restored.getArm("small-edit", "strong")).toEqual(original.getArm("small-edit", "strong"));
    store.close();
  });

  it("a restored router keeps favoring the arm it had already learned was better", () => {
    const store = new SqliteRouterStore(":memory:");
    const original = new Router(new SeededRng(42));
    original.register("small-edit", "cheap", 0.01);
    original.register("small-edit", "strong", 0.3);
    // heavily train "strong" to be the clear winner before ever saving
    for (let i = 0; i < 500; i++) {
      original.reportOutcome("small-edit", "strong", 0.98);
      original.reportOutcome("small-edit", "cheap", 0.2);
    }
    saveRouterState(original, store);

    const restored = loadRouterState(store, new SeededRng(7));
    const choices = Array.from({ length: 100 }, () => restored.route("small-edit"));

    expect(choices.filter((c) => c === "strong").length).toBeGreaterThan(90);
    store.close();
  });

  it("loads an empty store into a router with nothing registered", () => {
    const store = new SqliteRouterStore(":memory:");
    const restored = loadRouterState(store);
    expect(() => restored.route("anything")).toThrow();
    store.close();
  });
});
