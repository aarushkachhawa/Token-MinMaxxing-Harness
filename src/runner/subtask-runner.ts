import type { TaskClassifier } from "../classifier/task-classifier.js";
import type { ContextCompiler } from "../context/context-compiler.js";
import type { SubtaskOutput } from "../context/types.js";
import { Executor } from "../executor/executor.js";
import type { ModelClient, Tool } from "../executor/types.js";
import type { Subtask } from "../orchestrator/types.js";
import type { RewardCollector } from "../reward/reward-collector.js";
import type { Router } from "../router/bandit.js";
import type { EscalationClient } from "../router/escalation.js";
import { HybridRouter } from "../router/hybrid-router.js";
import type { SubtaskRunnerOptions, SubtaskRunResult } from "./types.js";

const DEFAULT_SYSTEM_PROMPT =
  "You are a careful coding assistant. If prior work is provided in the task, treat it as " +
  "established fact rather than re-investigating it. Be brief.";

interface Attempt {
  finalText: string;
  stopReason: "final_answer" | "max_turns_exceeded";
  reward: number;
}

/**
 * Runs one subtask end to end: compile its context, classify, route, execute, grade -- and if
 * the first attempt doesn't produce a final answer, retry once with forced escalation before
 * giving up. Without this, a dependent subtask silently inherits an empty/failed result even
 * when a stronger model might actually have finished the work (see the cascading-empty-context
 * failure this was built to fix). Bounded to a single retry, matching "escalate to the next
 * tier" rather than an open-ended retry loop; both attempts' outcomes are reported to the
 * bandit either way, since a real failure is real training signal regardless of which attempt's
 * output ends up being used.
 */
export class SubtaskRunner {
  constructor(
    private bandit: Router,
    private classifier: TaskClassifier,
    private rewardCollector: RewardCollector,
    private modelClient: ModelClient,
    private tools: Tool[],
    private contextCompiler: ContextCompiler,
    private escalationClient: EscalationClient,
    private options: SubtaskRunnerOptions = {}
  ) {}

  async run(
    subtask: Subtask,
    priorOutputs: ReadonlyMap<string, SubtaskOutput>
  ): Promise<SubtaskRunResult> {
    const prompt = this.contextCompiler.compilePrompt(subtask, priorOutputs);
    const classification = await this.classifier.classify(subtask.description);
    this.options.onCategoryDiscovered?.(classification.category);

    const router = new HybridRouter(
      this.bandit,
      this.escalationClient,
      this.options.hybridRouterOptions
    );

    const first = await this.attempt(subtask, classification.category, router, prompt, {
      forceEscalate: subtask.highRisk,
    });

    let best = first;
    let escalatedAfterFailure = false;
    if (first.stopReason !== "final_answer") {
      const retry = await this.attempt(subtask, classification.category, router, prompt, {
        forceEscalate: true,
      });
      escalatedAfterFailure = true;
      best = retry.reward > first.reward ? retry : first;
    }

    return {
      output: { subtaskId: subtask.id, description: subtask.description, finalText: best.finalText },
      reward: best.reward,
      escalatedAfterFailure,
    };
  }

  private async attempt(
    subtask: Subtask,
    category: string,
    router: HybridRouter,
    prompt: string,
    routeOptions: { forceEscalate: boolean }
  ): Promise<Attempt> {
    const decision = await router.route(category, subtask.description, routeOptions);
    const executor = new Executor(this.modelClient, this.tools, {
      maxTurns: this.options.executorMaxTurns,
    });
    const result = await executor.run(this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, prompt);
    const breakdown = await this.rewardCollector.score(subtask.description, result);
    router.reportOutcome(category, decision.modelId, breakdown.reward);

    return { finalText: result.finalText, stopReason: result.stopReason, reward: breakdown.reward };
  }
}
