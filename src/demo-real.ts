/**
 * Same pipeline as demo.ts, but every LLM-backed decision point calls a real Anthropic model
 * instead of a scripted one: decomposition (triage -> conditional explore -> structure),
 * classifier fallback, escalation, execution against real read_file/list_directory tools, and
 * judge sampling. Nothing left in this pipeline is a scripted stand-in.
 *
 * Spends real tokens on the key in .env every time it runs.
 * Usage: npm run demo:real-pipeline -- "your request description here"
 */
import { join } from "node:path";
import { AnthropicClassifierClient, DEFAULT_CLASSIFICATION_RULES, TaskClassifier } from "./classifier/index.js";
import { getAnthropicApiKey } from "./config/env.js";
import { ContextCompiler, type SubtaskOutput } from "./context/index.js";
import { AnthropicModelClient } from "./executor/anthropic-model-client.js";
import { AnthropicOrchestratorClient, Orchestrator } from "./orchestrator/index.js";
import { loadRouterState, saveRouterState, SqliteRouterStore } from "./persistence/index.js";
import { AnthropicJudgeClient } from "./reward/anthropic-judge-client.js";
import { RewardCollector } from "./reward/reward-collector.js";
import { AnthropicEscalationClient } from "./router/anthropic-escalation-client.js";
import { SubtaskRunner } from "./runner/index.js";
import { createListDirectoryTool, createReadFileTool } from "./tools/index.js";

const ROUTER_STATE_PATH = join(process.cwd(), "router-state.sqlite");

const SYSTEM_PROMPT =
  "You are a careful coding assistant working in this project's repository. Use " +
  "list_directory to explore the project structure and read_file to see a file's contents " +
  "(both take paths relative to the project root) -- don't assume a file exists if you " +
  "haven't found or read it. If prior work is provided below, treat it as established fact " +
  "rather than re-investigating it. Be brief.";

async function main() {
  const requestDescription = process.argv[2] ?? "explain what the ContextCompiler does";
  console.log(`\nRequest: "${requestDescription}"`);

  // Decompose into a subtask plan — real now: triage decides if repo context is even needed,
  // explore gathers it only if so, structure turns the (possibly grounded) request into a plan.
  const orchestratorClient = new AnthropicOrchestratorClient({
    apiKey: getAnthropicApiKey(),
    workspaceRoot: process.cwd(),
    onTriage: (triage) =>
      console.log(`Triage: needsExploration=${triage.needsExploration} -- ${triage.reasoning}`),
    onExploration: (summary) => console.log(`Exploration summary: ${summary}`),
  });
  const orchestrator = new Orchestrator(orchestratorClient);
  const plan = await orchestrator.plan(requestDescription);
  console.log(`Plan: ${plan.subtasks.map((s) => s.id).join(" -> ")}\n`);

  const classifier = new TaskClassifier({
    rules: DEFAULT_CLASSIFICATION_RULES,
    llmClient: new AnthropicClassifierClient({ apiKey: getAnthropicApiKey() }),
  });
  // Router state persists across runs in a SQLite file at the repo root -- this run picks up
  // wherever the last one left off instead of starting the bandit from scratch every time.
  const routerStore = new SqliteRouterStore(ROUTER_STATE_PATH);
  const bandit = loadRouterState(routerStore);
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
    new AnthropicEscalationClient({ apiKey: getAnthropicApiKey() }),
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
      // save after every subtask, not just at the end -- a crash mid-run shouldn't lose what
      // was already learned from the subtasks that did complete.
      saveRouterState(bandit, routerStore);
    }
  }

  routerStore.close();
  console.log("All subtasks complete.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
