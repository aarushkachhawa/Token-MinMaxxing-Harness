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
import { Orchestrator, ScriptedOrchestratorClient } from "./orchestrator/index.js";
import { AnthropicJudgeClient } from "./reward/anthropic-judge-client.js";
import { RewardCollector } from "./reward/reward-collector.js";
import { Router } from "./router/bandit.js";
import { ScriptedEscalationClient } from "./router/escalation.js";
import { SubtaskRunner } from "./runner/index.js";
import { createListDirectoryTool, createReadFileTool } from "./tools/index.js";

const SYSTEM_PROMPT =
  "You are a careful coding assistant working in this project's repository. Use " +
  "list_directory to explore the project structure and read_file to see a file's contents " +
  "(both take paths relative to the project root) -- don't assume a file exists if you " +
  "haven't found or read it. If prior work is provided below, treat it as established fact " +
  "rather than re-investigating it. Be brief.";

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
      onVerdict: (verdict) =>
        console.log(`Judge verdict: ${verdict.score.toFixed(2)} (${verdict.confidence}) -- ${verdict.rationale}`),
    }),
  });
  const modelClient = new AnthropicModelClient({ apiKey: getAnthropicApiKey() });
  const tools = [createReadFileTool(process.cwd()), createListDirectoryTool(process.cwd())];
  const contextCompiler = new ContextCompiler();
  const outputs = new Map<string, SubtaskOutput>();

  const runner = new SubtaskRunner(
    bandit,
    classifier,
    rewardCollector,
    modelClient,
    tools,
    contextCompiler,
    // each subtask can call escalation up to twice (cold-start on the first attempt, forced on
    // a retry) -- a generous fixed buffer rather than sizing this exactly to the plan.
    new ScriptedEscalationClient(Array(20).fill("smart-expensive")),
    {
      systemPrompt: SYSTEM_PROMPT,
      hybridRouterOptions: { minPullsBeforeConfident: 3 },
      onCategoryDiscovered: (category) => {
        if (bandit.getCandidates(category).length === 0) {
          bandit.register(category, "fast-cheap", 0.01);
          bandit.register(category, "smart-expensive", 0.3);
        }
      },
    }
  );

  const completed = new Set<string>();
  while (!orchestrator.isComplete(plan, completed)) {
    for (const subtask of orchestrator.getReadySubtasks(plan, completed)) {
      console.log(`--- Subtask "${subtask.id}": ${subtask.description} ---`);
      if (subtask.dependsOn.length > 0) {
        console.log(`Context from: ${subtask.dependsOn.join(", ")}`);
      }

      const { output, reward, escalatedAfterFailure } = await runner.run(subtask, outputs);

      console.log(`Final: "${output.finalText}"`);
      console.log(`Reward: ${reward.toFixed(2)}${escalatedAfterFailure ? " (after escalation retry)" : ""}\n`);

      outputs.set(subtask.id, output);
      completed.add(subtask.id);
    }
  }

  console.log("All subtasks complete.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
