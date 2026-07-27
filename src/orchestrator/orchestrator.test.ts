import { describe, expect, it } from "vitest";
import { ScriptedOrchestratorClient } from "./fakes.js";
import { Orchestrator } from "./orchestrator.js";
import type { Subtask, SubtaskPlan } from "./types.js";

function subtask(overrides: Partial<Subtask> & { id: string }): Subtask {
  return {
    description: `do ${overrides.id}`,
    dependsOn: [],
    highRisk: false,
    ...overrides,
  };
}

describe("Orchestrator.plan", () => {
  it("returns a valid plan from the client and passes the request through", async () => {
    const plan: SubtaskPlan = { subtasks: [subtask({ id: "a" })] };
    const client = new ScriptedOrchestratorClient([plan]);
    const orchestrator = new Orchestrator(client);

    const result = await orchestrator.plan("build a widget");

    expect(result).toEqual(plan);
    expect(client.receivedRequests[0].requestDescription).toBe("build a widget");
  });

  it("throws on an empty plan", async () => {
    const client = new ScriptedOrchestratorClient([{ subtasks: [] }]);
    const orchestrator = new Orchestrator(client);
    await expect(orchestrator.plan("task")).rejects.toThrow(/empty plan/);
  });

  it("throws on a duplicate subtask id", async () => {
    const client = new ScriptedOrchestratorClient([
      { subtasks: [subtask({ id: "a" }), subtask({ id: "a" })] },
    ]);
    const orchestrator = new Orchestrator(client);
    await expect(orchestrator.plan("task")).rejects.toThrow(/Duplicate subtask id/);
  });

  it("throws when a subtask depends on an unknown subtask", async () => {
    const client = new ScriptedOrchestratorClient([
      { subtasks: [subtask({ id: "a", dependsOn: ["ghost"] })] },
    ]);
    const orchestrator = new Orchestrator(client);
    await expect(orchestrator.plan("task")).rejects.toThrow(/unknown subtask/);
  });

  it("throws when a subtask depends on itself", async () => {
    const client = new ScriptedOrchestratorClient([
      { subtasks: [subtask({ id: "a", dependsOn: ["a"] })] },
    ]);
    const orchestrator = new Orchestrator(client);
    await expect(orchestrator.plan("task")).rejects.toThrow(/depends on itself/);
  });

  it("throws when subtask dependencies form a cycle", async () => {
    const client = new ScriptedOrchestratorClient([
      {
        subtasks: [
          subtask({ id: "a", dependsOn: ["b"] }),
          subtask({ id: "b", dependsOn: ["a"] }),
        ],
      },
    ]);
    const orchestrator = new Orchestrator(client);
    await expect(orchestrator.plan("task")).rejects.toThrow(/Cycle detected/);
  });

  it("preserves the highRisk flag from the plan", async () => {
    const plan: SubtaskPlan = { subtasks: [subtask({ id: "a", highRisk: true })] };
    const orchestrator = new Orchestrator(new ScriptedOrchestratorClient([plan]));
    const result = await orchestrator.plan("touches auth");
    expect(result.subtasks[0].highRisk).toBe(true);
  });
});

describe("Orchestrator DAG traversal", () => {
  const plan: SubtaskPlan = {
    subtasks: [
      subtask({ id: "a" }),
      subtask({ id: "b" }),
      subtask({ id: "c", dependsOn: ["a", "b"] }),
      subtask({ id: "d", dependsOn: ["c"] }),
    ],
  };
  const orchestrator = new Orchestrator(new ScriptedOrchestratorClient([]));

  it("returns only dependency-free subtasks as ready at the start", () => {
    const ready = orchestrator.getReadySubtasks(plan, new Set());
    expect(ready.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("unlocks a subtask once all of its dependencies are completed", () => {
    const ready = orchestrator.getReadySubtasks(plan, new Set(["a", "b"]));
    expect(ready.map((s) => s.id)).toEqual(["c"]);
  });

  it("does not re-offer an already-completed subtask", () => {
    const ready = orchestrator.getReadySubtasks(plan, new Set(["a", "b", "c"]));
    expect(ready.map((s) => s.id)).toEqual(["d"]);
  });

  it("does not offer a subtask whose dependencies are only partially met", () => {
    const ready = orchestrator.getReadySubtasks(plan, new Set(["a"]));
    expect(ready.map((s) => s.id)).toEqual(["b"]);
  });

  it("reports incomplete until every subtask id has been completed", () => {
    expect(orchestrator.isComplete(plan, new Set(["a", "b", "c"]))).toBe(false);
    expect(orchestrator.isComplete(plan, new Set(["a", "b", "c", "d"]))).toBe(true);
  });
});
