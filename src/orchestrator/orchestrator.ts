import type { OrchestratorClient, Subtask, SubtaskPlan } from "./types.js";

/**
 * Wraps an LLM-backed decomposition call with the validation and DAG bookkeeping that don't
 * need a model at all: no duplicate/unknown/self dependencies, no cycles, and figuring out
 * which subtasks are ready to run given what's completed so far.
 */
export class Orchestrator {
  private client: OrchestratorClient;

  constructor(client: OrchestratorClient) {
    this.client = client;
  }

  async plan(requestDescription: string): Promise<SubtaskPlan> {
    const plan = await this.client.decompose({ requestDescription });
    this.validate(plan);
    return plan;
  }

  /** Subtasks whose dependencies are all completed and that aren't themselves completed yet. */
  getReadySubtasks(plan: SubtaskPlan, completedIds: ReadonlySet<string>): Subtask[] {
    return plan.subtasks.filter(
      (subtask) =>
        !completedIds.has(subtask.id) && subtask.dependsOn.every((dep) => completedIds.has(dep))
    );
  }

  isComplete(plan: SubtaskPlan, completedIds: ReadonlySet<string>): boolean {
    return plan.subtasks.every((subtask) => completedIds.has(subtask.id));
  }

  private validate(plan: SubtaskPlan): void {
    if (plan.subtasks.length === 0) {
      throw new Error("Orchestrator produced an empty plan");
    }

    const ids = new Set<string>();
    for (const subtask of plan.subtasks) {
      if (ids.has(subtask.id)) {
        throw new Error(`Duplicate subtask id "${subtask.id}"`);
      }
      ids.add(subtask.id);
    }

    for (const subtask of plan.subtasks) {
      for (const dep of subtask.dependsOn) {
        if (dep === subtask.id) {
          throw new Error(`Subtask "${subtask.id}" depends on itself`);
        }
        if (!ids.has(dep)) {
          throw new Error(`Subtask "${subtask.id}" depends on unknown subtask "${dep}"`);
        }
      }
    }

    this.checkForCycles(plan);
  }

  private checkForCycles(plan: SubtaskPlan): void {
    const dependsOn = new Map(plan.subtasks.map((subtask) => [subtask.id, subtask.dependsOn]));
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Cycle detected in subtask dependencies involving "${id}"`);
      }
      visiting.add(id);
      for (const dep of dependsOn.get(id) ?? []) {
        visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
    };

    for (const id of dependsOn.keys()) {
      visit(id);
    }
  }
}
