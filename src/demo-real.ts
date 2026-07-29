/**
 * Same pipeline as demo.ts, but the executor calls a real Anthropic model against the real,
 * sandboxed read_file and list_directory tools instead of scripted/fake ones -- so both the
 * model's answers and its tool-calling decisions are genuine. Orchestrator decomposition,
 * classifier fallback, and escalation are still scripted; wiring those up to a real LLM is a
 * separate, unscoped step.
 *
 * Spends real tokens on the key in .env every time it runs.
 * Usage: npm run demo:real-pipeline -- "your request description here"
 */
import { DEFAULT_CLASSIFICATION_RULES, ScriptedClassifierClient, TaskClassifier } from "./classifier/index.js";
import { getAnthropicApiKey } from "./config/env.js";
import { ContextCompiler, type SubtaskOutput } from "./context/index.js";
import { AnthropicModelClient } from "./executor/anthropic-model-client.js";
import { Executor } from "./executor/executor.js";
import type { ModelClient, Tool } from "./executor/types.js";
import { Orchestrator, ScriptedOrchestratorClient, type Subtask } from "./orchestrator/index.js";
import { AnthropicJudgeClient } from "./reward/anthropic-judge-client.js";
import { RewardCollector } from "./reward/reward-collector.js";
import { Router } from "./router/bandit.js";
import { ScriptedEscalationClient } from "./router/escalation.js";
import { HybridRouter } from "./router/hybrid-router.js";
import { createListDirectoryTool, createReadFileTool } from "./tools/index.js";

async function runSubtask(
  subtask: Subtask,
  bandit: Router,
  classifier: TaskClassifier,
  rewardCollector: RewardCollector,
  modelClient: ModelClient,
  tools: Tool[],
  contextCompiler: ContextCompiler,
  outputs: Map<string, SubtaskOutput>
): Promise<void> {
  console.log(`--- Subtask "${subtask.id}": ${subtask.description} ---`);

  // Compile just this subtask's own dependencies' outputs into its prompt -- not the full
  // history of everything that ran before it.
  const prompt = contextCompiler.compilePrompt(subtask, outputs);
  if (subtask.dependsOn.length > 0) {
    console.log(`Context from: ${subtask.dependsOn.join(", ")}`);
  }

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

  // Execute — real tool-use loop against a real model and the real, sandboxed file tools.
  const executor = new Executor(modelClient, tools);
  const result = await executor.run(
    "You are a careful coding assistant working in this project's repository. Use " +
      "list_directory to explore the project structure and read_file to see a file's contents " +
      "(both take paths relative to the project root) -- don't assume a file exists if you " +
      "haven't found or read it. If prior work is provided below, treat it as established fact " +
      "rather than re-investigating it. Be brief.",
    prompt
  );
  console.log(`Executor finished ("${result.stopReason}"): "${result.finalText}"`);
  console.log(`Usage: ${JSON.stringify(result.usage)}`);

  // Grade — real proxy signals, computed from the executor's actual trace above.
  const breakdown = await rewardCollector.score(subtask.description, result);
  console.log(`Reward: ${breakdown.reward.toFixed(2)}`);

  // Feed the reward back into the router — this is the loop that lets it learn over time.
  router.reportOutcome(classification.category, decision.modelId, breakdown.reward);
  outputs.set(subtask.id, {
    subtaskId: subtask.id,
    description: subtask.description,
    finalText: result.finalText,
  });
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
  // Judge tier fires on a small sample of subtasks (see DEFAULT_JUDGE_SAMPLE_RATE) -- most runs
  // of this demo won't invoke it at all.
  const rewardCollector = new RewardCollector({
    judgeClient: new AnthropicJudgeClient({
      apiKey: getAnthropicApiKey(),
      onVerdict: (verdict) => console.log(`Judge verdict: ${verdict.score.toFixed(2)} (${verdict.confidence}) -- ${verdict.rationale}`),
    }),
  });
  const modelClient = new AnthropicModelClient({ apiKey: getAnthropicApiKey() });
  const tools = [createReadFileTool(process.cwd()), createListDirectoryTool(process.cwd())];
  const contextCompiler = new ContextCompiler();
  const outputs = new Map<string, SubtaskOutput>();

  const completed = new Set<string>();
  while (!orchestrator.isComplete(plan, completed)) {
    for (const subtask of orchestrator.getReadySubtasks(plan, completed)) {
      await runSubtask(subtask, bandit, classifier, rewardCollector, modelClient, tools, contextCompiler, outputs);
      completed.add(subtask.id);
    }
  }

  console.log("All subtasks complete.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
