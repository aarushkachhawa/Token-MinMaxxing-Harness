import { beforeEach, describe, expect, it } from "vitest";
import type { SubtaskOutput } from "../context/types.js";
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

function output(overrides: Partial<SubtaskOutput> & { subtaskId: string }): SubtaskOutput {
  return {
    description: `do ${overrides.subtaskId}`,
    finalText: `done: ${overrides.subtaskId}`,
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
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    orchestrator = new Orchestrator(new ScriptedOrchestratorClient([plan]));
    await orchestrator.plan("task");
  });

  it("returns only dependency-free subtasks as ready at the start", () => {
    const ready = orchestrator.getReadySubtasks(new Set());
    expect(ready.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("unlocks a subtask once all of its dependencies are completed", () => {
    const ready = orchestrator.getReadySubtasks(new Set(["a", "b"]));
    expect(ready.map((s) => s.id)).toEqual(["c"]);
  });

  it("does not re-offer an already-completed subtask", () => {
    const ready = orchestrator.getReadySubtasks(new Set(["a", "b", "c"]));
    expect(ready.map((s) => s.id)).toEqual(["d"]);
  });

  it("does not offer a subtask whose dependencies are only partially met", () => {
    const ready = orchestrator.getReadySubtasks(new Set(["a"]));
    expect(ready.map((s) => s.id)).toEqual(["b"]);
  });

  it("reports incomplete until every subtask id has been completed", () => {
    expect(orchestrator.isComplete(new Set(["a", "b", "c"]))).toBe(false);
    expect(orchestrator.isComplete(new Set(["a", "b", "c", "d"]))).toBe(true);
  });
});

describe("Orchestrator.replan", () => {
  async function orchestratorWithPlan(
    initialPlan: SubtaskPlan,
    replanPlans: SubtaskPlan[] = []
  ): Promise<{ orchestrator: Orchestrator; client: ScriptedOrchestratorClient }> {
    const client = new ScriptedOrchestratorClient([initialPlan], replanPlans);
    const orchestrator = new Orchestrator(client);
    await orchestrator.plan("original request");
    return { orchestrator, client };
  }

  it("merges new subtasks into the tracked plan and passes existing subtasks + completed outputs through", async () => {
    const initialPlan: SubtaskPlan = { subtasks: [subtask({ id: "a" })] };
    const newPlan: SubtaskPlan = { subtasks: [subtask({ id: "b", dependsOn: ["a"] })] };
    const { orchestrator, client } = await orchestratorWithPlan(initialPlan, [newPlan]);
    const completedOutputs = [output({ subtaskId: "a" })];

    const merged = await orchestrator.replan("original request", completedOutputs);

    expect(merged.subtasks.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(client.receivedReplanRequests[0]).toEqual({
      originalRequest: "original request",
      existingSubtasks: initialPlan.subtasks,
      completedOutputs,
    });
    // getReadySubtasks/isComplete now read the merged plan.
    expect(orchestrator.getReadySubtasks(new Set(["a"])).map((s) => s.id)).toEqual(["b"]);
  });

  it("throws when a new subtask's id collides with an existing subtask's id", async () => {
    const initialPlan: SubtaskPlan = { subtasks: [subtask({ id: "a" })] };
    const newPlan: SubtaskPlan = { subtasks: [subtask({ id: "a" })] };
    const { orchestrator } = await orchestratorWithPlan(initialPlan, [newPlan]);

    await expect(orchestrator.replan("original request", [])).rejects.toThrow(/Duplicate subtask id/);
  });

  it("accepts a new subtask that depends on an existing subtask's id", async () => {
    const initialPlan: SubtaskPlan = { subtasks: [subtask({ id: "a" })] };
    const newPlan: SubtaskPlan = { subtasks: [subtask({ id: "b", dependsOn: ["a"] })] };
    const { orchestrator } = await orchestratorWithPlan(initialPlan, [newPlan]);

    const merged = await orchestrator.replan("original request", [output({ subtaskId: "a" })]);

    expect(merged.subtasks.find((s) => s.id === "b")?.dependsOn).toEqual(["a"]);
  });

  it("throws when a cycle spans both existing and new subtasks", async () => {
    // An existing subtask's dependsOn is fixed and validated before any new subtask id exists,
    // so it can never point *at* a new subtask -- a cycle can't loop back through an existing
    // node. What it can do is participate in a merged graph where a new subtask legitimately
    // depends on it while two other new subtasks cycle back on each other: "b" depends on the
    // existing "a" *and* on new "c", while "c" depends back on "b" -- a cycle that only shows up
    // once existing and new subtasks are validated together as one graph.
    const initialPlan: SubtaskPlan = { subtasks: [subtask({ id: "a" })] };
    const newPlan: SubtaskPlan = {
      subtasks: [
        subtask({ id: "b", dependsOn: ["a", "c"] }),
        subtask({ id: "c", dependsOn: ["b"] }),
      ],
    };
    const { orchestrator } = await orchestratorWithPlan(initialPlan, [newPlan]);

    await expect(orchestrator.replan("original request", [])).rejects.toThrow(/Cycle detected/);
  });

  it("leaves the plan unchanged when replan returns an empty subtasks list", async () => {
    const initialPlan: SubtaskPlan = { subtasks: [subtask({ id: "a" })] };
    const { orchestrator } = await orchestratorWithPlan(initialPlan, [{ subtasks: [] }]);

    const merged = await orchestrator.replan("original request", [output({ subtaskId: "a" })]);

    expect(merged.subtasks.map((s) => s.id)).toEqual(["a"]);
    expect(orchestrator.isComplete(new Set(["a"]))).toBe(true);
  });
});
