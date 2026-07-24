/**
 * Runnable, end-to-end walk through every piece built so far, wired together with fakes
 * standing in for the parts that need a real LLM (classifier fallback, escalation, the model
 * itself). Try: npm run demo -- "your task description here"
 */
import { DEFAULT_CLASSIFICATION_RULES, ScriptedClassifierClient, TaskClassifier } from "./classifier/index.js";
import { Executor } from "./executor/executor.js";
import { fakeTool, ScriptedModelClient } from "./executor/fakes.js";
import { RewardCollector } from "./reward/reward-collector.js";
import { Router } from "./router/bandit.js";
import { ScriptedEscalationClient } from "./router/escalation.js";
import { HybridRouter } from "./router/hybrid-router.js";

async function main() {
  const taskDescription = process.argv[2] ?? "fix the off-by-one bug in the loop";
  console.log(`\nTask: "${taskDescription}"`);

  // 1. Classify — real heuristics, with a scripted LLM fallback for anything they don't cover.
  const classifier = new TaskClassifier({
    rules: DEFAULT_CLASSIFICATION_RULES,
    llmClient: new ScriptedClassifierClient(["exploration"]),
  });
  const classification = await classifier.classify(taskDescription);
  console.log(`Classified as: "${classification.category}" (via ${classification.source})`);

  // 2. Route — real Thompson-sampling bandit; a scripted client stands in for the LLM
  //    escalation path, which fires here because this category has no history yet.
  const bandit = new Router();
  bandit.register(classification.category, "fast-cheap", 0.01);
  bandit.register(classification.category, "smart-expensive", 0.3);
  const router = new HybridRouter(bandit, new ScriptedEscalationClient(["smart-expensive"]));
  const decision = await router.route(classification.category, taskDescription);
  console.log(`Routed to: "${decision.modelId}" (escalated: ${decision.escalated})`);

  // 3. Execute — real tool-use loop; a scripted model client stands in for a real provider.
  const readFile = fakeTool("read_file", async () => ({ contents: "// TODO: fix this loop" }));
  const client = new ScriptedModelClient([
    {
      toolCalls: [{ id: "c1", toolName: "read_file", args: { path: "loop.ts" } }],
      text: null,
      usage: { inputTokens: 40, outputTokens: 8 },
    },
    {
      toolCalls: [],
      text: "Fixed the loop bound from <= to <.",
      usage: { inputTokens: 50, outputTokens: 12 },
    },
  ]);
  const executor = new Executor(client, [readFile]);
  const result = await executor.run("You are a careful coding assistant.", taskDescription);
  console.log(`Executor finished ("${result.stopReason}"): "${result.finalText}"`);

  // 4. Grade — real proxy signals, computed from the executor's actual trace above.
  const rewardCollector = new RewardCollector();
  const breakdown = await rewardCollector.score(taskDescription, result);
  console.log(`Reward: ${breakdown.reward.toFixed(2)} (proxy signals: ${breakdown.proxy?.toFixed(2)})`);

  // 5. Feed the reward back into the router — this is the loop that lets it learn over time.
  router.reportOutcome(classification.category, decision.modelId, breakdown.reward);
  const arm = bandit.getArm(classification.category, decision.modelId)!;
  console.log(
    `Updated stats for "${decision.modelId}": alpha=${arm.alpha.toFixed(2)}, beta=${arm.beta.toFixed(2)}\n`
  );
}

main();
