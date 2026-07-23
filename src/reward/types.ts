import type { ExecutionResult } from "../executor/types.js";

export interface DeterministicCheck {
  name: string;
  run(result: ExecutionResult): Promise<boolean>;
}

/** Pure, synchronous signal computed directly from the executor's trace — no external dependency. */
export interface ProxySignal {
  name: string;
  compute(result: ExecutionResult): number;
}

export interface JudgeRequest {
  taskDescription: string;
  result: ExecutionResult;
}

/** Reads the actual task + result and returns a quality score in [0, 1]. */
export interface JudgeClient {
  judge(request: JudgeRequest): Promise<number>;
}

export interface TierScores {
  deterministic?: number;
  proxy?: number;
  judge?: number;
}

export interface RewardBreakdown extends TierScores {
  reward: number;
}
