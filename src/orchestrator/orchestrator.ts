import type { SubtaskOutput } from "../context/types.js";
import type { OrchestratorClient, Subtask, SubtaskPlan } from "./types.js";

/**
 * Wraps an LLM-backed decomposition call with the validation and DAG bookkeeping that don't
 * need a model at all: no duplicate/unknown/self dependencies, no cycles, and figuring out
 * which subtasks are ready to run given what's completed so far.
 *
 * Holds the current plan as internal state (set by plan(), grown by replan()) rather than
 * having callers thread a plan through every call — replan() merges new subtasks into the same
 * tracked plan, so there'd otherwise be no single source of truth for "the plan" a caller could
 * pass consistently across a run.
 */
export class Orchestrator {
  private client: OrchestratorClient;
  private currentPlan: SubtaskPlan = { subtasks: [] };

  constructor(client: OrchestratorClient) {
    this.client = client;
  }

  async plan(requestDescription: string): Promise<SubtaskPlan> {
    const plan = await this.client.decompose({ requestDescription });
    if (plan.subtasks.length === 0) {
      throw new Error("Orchestrator produced an empty plan");
    }
    this.validateSubtaskList(plan.subtasks);
    this.currentPlan = plan;
    return plan;
  }

  /**
   * Asks the client whether the original request needs additional subtasks beyond what's
   * already been planned, given what's actually been completed so far. Unlike plan(), an empty
   * result is valid and simply means no further work is needed -- the tracked plan is left
   * unchanged in that case.
   *
   * New subtasks are validated against the FULL merged graph (existing + new): no duplicate ids
   * across old and new, every dependsOn must resolve to an existing-or-new id, no self-deps, no
   * cycles spanning both. On success the new subtasks are merged into the tracked plan and the
   * merged plan is returned; on failure the tracked plan is left untouched.
   */
  async replan(originalRequest: string, completedOutputs: SubtaskOutput[]): Promise<SubtaskPlan> {
    const existingSubtasks = this.currentPlan.subtasks;
    const newPlan = await this.client.replan({
      originalRequest,
      existingSubtasks,
      completedOutputs,
    });

    const merged = [...existingSubtasks, ...newPlan.subtasks];
    this.validateSubtaskList(merged);

    this.currentPlan = { subtasks: merged };
    return this.currentPlan;
  }

  /** Subtasks whose dependencies are all completed and that aren't themselves completed yet. */
  getReadySubtasks(completedIds: ReadonlySet<string>): Subtask[] {
    return this.currentPlan.subtasks.filter(
      (subtask) =>
        !completedIds.has(subtask.id) && subtask.dependsOn.every((dep) => completedIds.has(dep))
    );
  }

  isComplete(completedIds: ReadonlySet<string>): boolean {
    return this.currentPlan.subtasks.every((subtask) => completedIds.has(subtask.id));
  }

  /**
   * Duplicate/unknown/self dependency checks plus cycle detection, against an arbitrary subtask
   * list. Used both for a fresh plan() (list = the new plan itself) and for replan() (list = the
   * existing + new subtasks combined), so the DAG rules live in exactly one place.
   */
  private validateSubtaskList(subtasks: Subtask[]): void {
    const ids = new Set<string>();
    for (const subtask of subtasks) {
      if (ids.has(subtask.id)) {
        throw new Error(`Duplicate subtask id "${subtask.id}"`);
      }
      ids.add(subtask.id);
    }

    for (const subtask of subtasks) {
      for (const dep of subtask.dependsOn) {
        if (dep === subtask.id) {
          throw new Error(`Subtask "${subtask.id}" depends on itself`);
        }
        if (!ids.has(dep)) {
          throw new Error(`Subtask "${subtask.id}" depends on unknown subtask "${dep}"`);
        }
      }
    }

    this.checkForCycles(subtasks);
  }

  private checkForCycles(subtasks: Subtask[]): void {
    const dependsOn = new Map(subtasks.map((subtask) => [subtask.id, subtask.dependsOn]));
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
