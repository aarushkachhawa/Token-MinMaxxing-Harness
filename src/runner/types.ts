import type { BudgetGovernor } from "../budget/budget-governor.js";
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
  /** When set, each attempt asks it for the current costWeight before routing and reports its
   * real (cache-aware) token spend back to it afterward, so a run's actual burn-rate feeds back
   * into routing instead of costWeight staying permanently at 0. Optional: omitting it reproduces
   * the previous behavior exactly (pure quality routing, no spend tracking). */
  budgetGovernor?: BudgetGovernor;
}
