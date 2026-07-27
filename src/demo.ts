/**
 * Runnable, end-to-end walk through every piece built so far, wired together with fakes
 * standing in for the parts that need a real LLM (decomposition, classifier fallback,
 * escalation, the model itself). Try: npm run demo -- "your request description here"
 */
import { DEFAULT_CLASSIFICATION_RULES, ScriptedClassifierClient, TaskClassifier } from "./classifier/index.js";
import { Executor } from "./executor/executor.js";
import { fakeTool, ScriptedModelClient } from "./executor/fakes.js";
import { Orchestrator, ScriptedOrchestratorClient, type Subtask } from "./orchestrator/index.js";
import { RewardCollector } from "./reward/reward-collector.js";
import { Router } from "./router/bandit.js";
import { ScriptedEscalationClient } from "./router/escalation.js";
import { HybridRouter } from "./router/hybrid-router.js";

async function runSubtask(
  subtask: Subtask,
  bandit: Router,
  classifier: TaskClassifier,
  rewardCollector: RewardCollector
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

  // Execute — real tool-use loop; a scripted model client stands in for a real provider.
  const readFile = fakeTool("read_file", async () => ({ contents: "// TODO: fix this loop" }));
  const client = new ScriptedModelClient([
    {
      toolCalls: [{ id: "c1", toolName: "read_file", args: { path: "loop.ts" } }],
      text: null,
      usage: { inputTokens: 40, outputTokens: 8 },
    },
    { toolCalls: [], text: `Completed: ${subtask.description}`, usage: { inputTokens: 50, outputTokens: 12 } },
  ]);
  const executor = new Executor(client, [readFile]);
  const result = await executor.run("You are a careful coding assistant.", subtask.description);
  console.log(`Executor finished ("${result.stopReason}"): "${result.finalText}"`);

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

  // Decompose into a subtask plan — scripted, since no real LLM is wired up yet.
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

  const completed = new Set<string>();
  while (!orchestrator.isComplete(plan, completed)) {
    for (const subtask of orchestrator.getReadySubtasks(plan, completed)) {
      await runSubtask(subtask, bandit, classifier, rewardCollector);
      completed.add(subtask.id);
    }
  }

  console.log("All subtasks complete.\n");
}

main();
