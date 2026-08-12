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

/** One completed turn of a multi-turn interactive session: the user's request and the answer produced. */
export interface ConversationTurn {
  requestDescription: string;
  finalText: string;
  /**
   * Set once, lazily, the moment this turn ages out of formatConversationHistory's recent-detail
   * window (see findTurnsNeedingSummary) -- a dense one-sentence LLM summary used for the
   * condensed-tier mention in place of the bare request text. Undefined until then, and never
   * recomputed afterward.
   */
  summary?: string;
}

export interface OrchestratorRequest {
  requestDescription: string;
  /**
   * Prior turns in this session, oldest first, so decompose() can resolve a follow-up's vague
   * references ("that file", "it", "now change X") into something concrete. Empty/omitted for a
   * fresh session or a one-shot run -- see demo-real.ts, which never has more than one turn.
   */
  conversationHistory?: ConversationTurn[];
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
