import type { SubtaskOutput } from "../context/types.js";

export interface Subtask {
  id: string;
  description: string;
  dependsOn: string[];
  /** Signals this subtask should escalate regardless of the router's confidence (e.g. touches auth/payments). */
  highRisk: boolean;
}

export interface SubtaskPlan {
  subtasks: Subtask[];
}

export interface OrchestratorRequest {
  requestDescription: string;
}

/**
 * Everything a replan call needs to decide whether the original request requires more work:
 * the request itself, the subtasks already known (whether completed or still pending), and the
 * actual outputs produced so far.
 */
export interface ReplanContext {
  originalRequest: string;
  existingSubtasks: Subtask[];
  completedOutputs: SubtaskOutput[];
}

/** Reads the actual request and proposes a subtask DAG. Runs on a fixed, capable model — not itself routed. */
export interface OrchestratorClient {
  decompose(request: OrchestratorRequest): Promise<SubtaskPlan>;
  /**
   * Given what's already planned and what's actually been completed, proposes additional
   * subtasks (or none) needed to fully satisfy the original request. Unlike decompose(), an
   * empty `subtasks` result is a valid answer here — it means no further work is needed.
   */
  replan(context: ReplanContext): Promise<SubtaskPlan>;
}
