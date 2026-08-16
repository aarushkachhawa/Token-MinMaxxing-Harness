export interface SweBenchInstance {
  instanceId: string;
  repo: string;
  baseCommit: string;
  problemStatement: string;
}

/** One row of the per-instance log each agent's pilot driver appends to -- the raw material
 * report.ts aggregates into the comparison table (resolve rate comes from the separate SWE-bench
 * grader report instead, since resolution is never self-reported by either agent). */
export interface InstanceRunLog {
  instanceId: string;
  wallClockMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  patchIsEmpty: boolean;
}
