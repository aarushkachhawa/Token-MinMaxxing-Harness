import type { SubtaskOutput } from "../context/types.js";
import type { HybridRouterOptions } from "../router/hybrid-router.js";

export interface SubtaskRunResult {
  output: SubtaskOutput;
  reward: number;
  /** True if the first attempt didn't produce a final answer and a forced-escalation retry ran. */
  escalatedAfterFailure: boolean;
}

export interface SubtaskRunnerOptions {
  systemPrompt?: string;
  executorMaxTurns?: number;
  hybridRouterOptions?: HybridRouterOptions;
  /** Called right after classification, before routing -- e.g. to lazily register bandit arms for a newly-seen category. */
  onCategoryDiscovered?: (category: string) => void;
}
