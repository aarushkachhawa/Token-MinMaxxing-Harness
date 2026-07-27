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

/** Reads the actual request and proposes a subtask DAG. Runs on a fixed, capable model — not itself routed. */
export interface OrchestratorClient {
  decompose(request: OrchestratorRequest): Promise<SubtaskPlan>;
}
