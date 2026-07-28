/**
 * Same pipeline as demo.ts, but the executor calls a real Anthropic model against the real,
 * sandboxed read_file tool instead of scripted/fake ones -- so both the model's answers and
 * its tool-calling decisions are genuine. Orchestrator decomposition, classifier fallback, and
 * escalation are still scripted; wiring those up to a real LLM is a separate, unscoped step.
 *
 * Spends real tokens on the key in .env every time it runs.
 * Usage: npm run demo:real-pipeline -- "your request description here"
 */
import { DEFAULT_CLASSIFICATION_RULES, ScriptedClassifierClient, TaskClassifier } from "./classifier/index.js";
import { getAnthropicApiKey } from "./config/env.js";
import { AnthropicModelClient } from "./executor/anthropic-model-client.js";
import { Executor } from "./executor/executor.js";
import type { ModelClient, Tool } from "./executor/types.js";
import { Orchestrator, ScriptedOrchestratorClient, type Subtask } from "./orchestrator/index.js";
import { RewardCollector } from "./reward/reward-collector.js";
import { Router } from "./router/bandit.js";
import { ScriptedEscalationClient } from "./router/escalation.js";
import { HybridRouter } from "./router/hybrid-router.js";
import { createReadFileTool } from "./tools/index.js";

async function runSubtask(
  subtask: Subtask,
  bandit: Router,
  classifier: TaskClassifier,
  rewardCollector: RewardCollector,
  modelClient: ModelClient,
  readFileTool: Tool
): Promise<void> {
  console.log(`--- Subtask "${subtask.id}": ${subtask.description} ---`);

  // Classify — real heuristics, with a scripted LLM fallback for anything they don't cover.
  const classification = await classifier.classify(subtask.description);
  console.log(`Classified as: "${classification.category}" (via ${classification.source})`);

  // Route — real Thompson-sampling bandit, shared across subtasks so learning persists
  // between them; a scripted client stands in for LLM escalation.
  if (bandit.getCandidates(classification.category).length === 0) {
    bandit.register(classification.category, "fast-cheap", 0.01);
    bandit.register(classification.category, "smart-expensive", 0.3);
  }
  const router = new HybridRouter(bandit, new ScriptedEscalationClient(["smart-expensive"]), {
    minPullsBeforeConfident: 3,
  });
  const decision = await router.route(classification.category, subtask.description, {
    forceEscalate: subtask.highRisk,
  });
  console.log(`Routed to: "${decision.modelId}" (escalated: ${decision.escalated})`);

  // Execute — real tool-use loop against a real model and the real, sandboxed read_file tool.
  const executor = new Executor(modelClient, [readFileTool]);
  const result = await executor.run(
    "You are a careful coding assistant working in this project's repository. Use the " +
      "read_file tool (paths relative to the project root, e.g. README.md) if you need to see " +
      "a file before answering -- don't assume a file exists if you haven't read it. Be brief.",
    subtask.description
  );
  console.log(`Executor finished ("${result.stopReason}"): "${result.finalText}"`);
  console.log(`Usage: ${JSON.stringify(result.usage)}`);

  // Grade — real proxy signals, computed from the executor's actual trace above.
  const breakdown = await rewardCollector.score(subtask.description, result);
  console.log(`Reward: ${breakdown.reward.toFixed(2)}`);

  // Feed the reward back into the router — this is the loop that lets it learn over time.
  router.reportOutcome(classification.category, decision.modelId, breakdown.reward);
  console.log("");
}

async function main() {
  const requestDescription =
    process.argv[2] ?? "fix the off-by-one bug in the loop and add a regression test";
  console.log(`\nRequest: "${requestDescription}"`);

  // Decompose into a subtask plan — still scripted, since real decomposition is unscoped.
  const orchestratorClient = new ScriptedOrchestratorClient([
    {
      subtasks: [
        { id: "investigate", description: "find where the off-by-one bug is", dependsOn: [], highRisk: false },
        {
          id: "fix",
          description: "fix the off-by-one bug in the loop",
          dependsOn: ["investigate"],
          highRisk: false,
        },
        {
          id: "test",
          description: "write a unit test for the fix",
          dependsOn: ["fix"],
          highRisk: false,
        },
      ],
    },
  ]);
  const orchestrator = new Orchestrator(orchestratorClient);
  const plan = await orchestrator.plan(requestDescription);
  console.log(`Plan: ${plan.subtasks.map((s) => s.id).join(" -> ")}\n`);

  const classifier = new TaskClassifier({
    rules: DEFAULT_CLASSIFICATION_RULES,
    llmClient: new ScriptedClassifierClient(["test-authoring"]),
  });
  const bandit = new Router();
  const rewardCollector = new RewardCollector();
  const modelClient = new AnthropicModelClient({ apiKey: getAnthropicApiKey() });
  const readFileTool = createReadFileTool(process.cwd());

  const completed = new Set<string>();
  while (!orchestrator.isComplete(plan, completed)) {
    for (const subtask of orchestrator.getReadySubtasks(plan, completed)) {
      await runSubtask(subtask, bandit, classifier, rewardCollector, modelClient, readFileTool);
      completed.add(subtask.id);
    }
  }

  console.log("All subtasks complete.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
