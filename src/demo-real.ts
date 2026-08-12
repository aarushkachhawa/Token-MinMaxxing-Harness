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
import { AnthropicModelClientFactory } from "./executor/anthropic-model-client-factory.js";
import { AnthropicOrchestratorClient, Orchestrator } from "./orchestrator/index.js";
import { loadRouterState, saveRouterState, SqliteRouterStore } from "./persistence/index.js";
import { AnthropicJudgeClient } from "./reward/anthropic-judge-client.js";
import { RewardCollector } from "./reward/reward-collector.js";
import { AnthropicEscalationClient } from "./router/anthropic-escalation-client.js";
import { SubtaskRunner } from "./runner/index.js";
import {
  createListDirectoryTool,
  createReadFileTool,
  createWriteFileTool,
  interactiveWriteApprovalGate,
} from "./tools/index.js";

const ROUTER_STATE_PATH = join(process.cwd(), "router-state.sqlite");
// Real, constructable model ids -- these ARE what gets registered as bandit arms below, so
// whatever the router picks is what AnthropicModelClientFactory can actually build a client for.
const FAST_CHEAP_MODEL_ID = "claude-haiku-4-5-20251001";
const SMART_EXPENSIVE_MODEL_ID = "claude-sonnet-5";

const SYSTEM_PROMPT =
  "You are a careful coding assistant working in this project's repository. Use " +
  "list_directory to explore the project structure and read_file to see a file's contents " +
  "(both take paths relative to the project root) -- don't assume a file exists if you " +
  "haven't found or read it. write_file is available to create or overwrite files, but every " +
  "write requires explicit human approval before it takes effect, so don't be surprised if a " +
  "write is rejected. If prior work is provided below, treat it as established fact rather " +
  "than re-investigating it. Be brief.";

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
  const modelClientFactory = new AnthropicModelClientFactory({ apiKey: getAnthropicApiKey() });
  // write_file here is scoped to this actual repository (not a scratch dir like
  // write-file-check.ts), so every write is gated on an interactive terminal approval that
  // prints the before/after content and defaults to refusing -- see write-approval-gate.ts.
  const tools = [
    createReadFileTool(process.cwd()),
    createListDirectoryTool(process.cwd()),
    createWriteFileTool(process.cwd(), { onBeforeWrite: interactiveWriteApprovalGate }),
  ];
  const contextCompiler = new ContextCompiler();
  const outputs = new Map<string, SubtaskOutput>();

  const runner = new SubtaskRunner(
    bandit,
    classifier,
    rewardCollector,
    modelClientFactory,
    tools,
    contextCompiler,
    new AnthropicEscalationClient({ apiKey: getAnthropicApiKey() }),
    {
      systemPrompt: SYSTEM_PROMPT,
      // A subtask that needs to explore the repo before it can act (find + read a few files,
      // then answer or write) can easily need more than the Executor default of 10 turns -- see
      // DEFAULT_EXPLORE_MAX_TURNS in anthropic-orchestrator-client.ts for the same tradeoff.
      executorMaxTurns: 15,
      hybridRouterOptions: { minPullsBeforeConfident: 3 },
      onCategoryDiscovered: (category) => {
        if (bandit.getCandidates(category).length === 0) {
          bandit.register(category, FAST_CHEAP_MODEL_ID, 0.01);
          bandit.register(category, SMART_EXPENSIVE_MODEL_ID, 0.3);
        }
      },
    }
  );

  const completed = new Set<string>();
  const allOutputs: SubtaskOutput[] = [];
  // Tracks every subtask id the orchestrator has ever handed out (initial plan + anything
  // replan() has added), so a replan response can be diffed against it to tell "added new work"
  // apart from "just re-listed what we already knew about".
  const knownIds = new Set(plan.subtasks.map((s) => s.id));

  for (;;) {
    while (!orchestrator.isComplete(completed)) {
      for (const subtask of orchestrator.getReadySubtasks(completed)) {
        console.log(`--- Subtask "${subtask.id}": ${subtask.description} ---`);
        if (subtask.dependsOn.length > 0) {
          console.log(`Context from: ${subtask.dependsOn.join(", ")}`);
        }

        const { output, reward, escalatedAfterFailure } = await runner.run(subtask, outputs);

        console.log(`Final: "${output.finalText}"`);
        console.log(`Reward: ${reward.toFixed(2)}${escalatedAfterFailure ? " (after escalation retry)" : ""}\n`);

        outputs.set(subtask.id, output);
        allOutputs.push(output);
        completed.add(subtask.id);
        // save after every subtask, not just at the end -- a crash mid-run shouldn't lose what
        // was already learned from the subtasks that did complete.
        saveRouterState(bandit, routerStore);
      }
    }

    // Every subtask the orchestrator currently knows about has completed. Re-enter the
    // orchestrator once to see whether what actually got produced reveals more work the
    // original plan didn't anticipate, rather than assuming the first plan was complete.
    console.log("Checking whether the plan needs additional subtasks...");
    const merged = await orchestrator.replan(requestDescription, allOutputs);
    const newSubtasks = merged.subtasks.filter((subtask) => !knownIds.has(subtask.id));

    if (newSubtasks.length === 0) {
      console.log("Replanning found no further work needed.\n");
      break;
    }

    console.log(
      `Replanning added ${newSubtasks.length} new subtask(s): ${newSubtasks.map((s) => s.id).join(", ")}\n`
    );
    for (const subtask of newSubtasks) {
      knownIds.add(subtask.id);
    }
  }

  routerStore.close();
  console.log("All subtasks complete.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
