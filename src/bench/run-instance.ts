/**
 * One-shot, non-interactive runner: same real pipeline as demo-real.ts (AnthropicOrchestratorClient,
 * TaskClassifier, SqliteRouterStore-backed bandit, RewardCollector, AnthropicModelClientFactory, all
 * five real tools, SubtaskRunner), but pointed at an arbitrary workspace instead of process.cwd(),
 * reading the request from a file instead of argv (SWE-bench problem statements are long/multi-line),
 * writing/editing/running commands autonomously (every *ToolOptions.onBefore* hook is omitted -- there's
 * no human to approve a benchmark run), and totaling real Anthropic API token usage across every call
 * by wrapping fetch, since none of the five Anthropic-backed clients (orchestrator, classifier,
 * executor, judge, escalation) currently expose their per-call usage up through their return types.
 *
 * Uses AnthropicModelClientFactory (not a single fixed AnthropicModelClient), matching the
 * router-to-execution wiring fix in subtask-runner.ts -- the router's chosen modelId now actually
 * determines which model executes each subtask/retry, not just which arm gets bandit credit.
 *
 * Also wires in edit_file and run_command (added post-pilot, closing the two structural gaps the
 * first pilot report traced three unresolved SWE-bench instances back to: no way to actually run
 * tests/verify a fix, and write_file's full-file-rewrite requirement risking silent corruption of
 * large files). Safe to run autonomously here specifically because every instance is already a
 * disposable git clone -- run_command's containment comes entirely from the caller using a
 * throwaway workspace, per its own doc comment, which is exactly this setup.
 *
 * Usage: tsx --env-file=.env src/bench/run-instance.ts <workspaceRoot> <requestFilePath> <outputJsonPath>
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AnthropicClassifierClient, DEFAULT_CLASSIFICATION_RULES, TaskClassifier } from "../classifier/index.js";
import { getAnthropicApiKey } from "../config/env.js";
import { ContextCompiler, type SubtaskOutput } from "../context/index.js";
import { AnthropicModelClientFactory } from "../executor/anthropic-model-client-factory.js";
import { AnthropicOrchestratorClient, Orchestrator } from "../orchestrator/index.js";
import { loadRouterState, SqliteRouterStore } from "../persistence/index.js";
import { AnthropicJudgeClient } from "../reward/anthropic-judge-client.js";
import { RewardCollector } from "../reward/reward-collector.js";
import { AnthropicEscalationClient } from "../router/anthropic-escalation-client.js";
import { SubtaskRunner } from "../runner/index.js";
import {
  createEditFileTool,
  createListDirectoryTool,
  createReadFileTool,
  createRunCommandTool,
  createWriteFileTool,
} from "../tools/index.js";

// Real, constructable model ids -- matches demo-real.ts/cli.ts post-#13. Whatever the router
// picks is what AnthropicModelClientFactory can actually build a client for.
const FAST_CHEAP_MODEL_ID = "claude-haiku-4-5-20251001";
const SMART_EXPENSIVE_MODEL_ID = "claude-sonnet-5";

const SYSTEM_PROMPT =
  "You are a careful coding assistant working in this project's repository. Use " +
  "list_directory to explore the project structure and read_file to see a file's contents " +
  "(both take paths relative to the project root) -- don't assume a file exists if you " +
  "haven't found or read it. Prefer edit_file for a targeted change to an existing file -- it " +
  "only needs the exact excerpt that's changing, not the whole file; use write_file only to " +
  "create a new file or replace one entirely. run_command runs a shell command in the project " +
  "root -- use it to actually run tests, check that something imports cleanly, or reproduce a " +
  "bug before you claim it's fixed. A fix you never ran is not a finished task. Be brief.";

interface UsageTotals {
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Wraps global fetch to total usage off every non-streaming Anthropic Messages API response,
 * regardless of which of the five Anthropic-backed clients made the call -- cheaper than plumbing
 * a usage callback through each one individually for a single benchmark run. Tracks
 * cache_creation_input_tokens/cache_read_input_tokens separately from fresh input_tokens (not
 * just summed together) since prompt caching (see prompt-caching.ts) means those are billed at
 * very different rates -- collapsing them into one "inputTokens" number would make cost
 * estimates meaningless the moment caching actually hits. */
function installFetchUsageTracker(): UsageTotals {
  const totals: UsageTotals = {
    apiCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    if (url.includes("api.anthropic.com")) {
      response
        .clone()
        .json()
        .then((body) => {
          const usage = body?.usage;
          if (usage) {
            totals.apiCalls += 1;
            totals.inputTokens += usage.input_tokens ?? 0;
            totals.outputTokens += usage.output_tokens ?? 0;
            totals.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
            totals.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
          }
        })
        .catch(() => {
          // best-effort: a non-JSON or error response just isn't counted, doesn't fail the run
        });
    }
    return response;
  }) as typeof fetch;

  return totals;
}

async function main() {
  const [workspaceRoot, requestFilePath, outputJsonPath] = process.argv.slice(2);
  if (!workspaceRoot || !requestFilePath || !outputJsonPath) {
    console.error("Usage: run-instance.ts <workspaceRoot> <requestFilePath> <outputJsonPath>");
    process.exitCode = 1;
    return;
  }

  const requestDescription = (await readFile(requestFilePath, "utf-8")).trim();
  const usage = installFetchUsageTracker();
  const startedAt = Date.now();

  const apiKey = getAnthropicApiKey();
  const orchestratorClient = new AnthropicOrchestratorClient({
    apiKey,
    workspaceRoot,
    onTriage: (triage) => console.log(`Triage: needsExploration=${triage.needsExploration} -- ${triage.reasoning}`),
    onExploration: (summary) => console.log(`Exploration summary: ${summary}`),
  });
  const orchestrator = new Orchestrator(orchestratorClient);
  const plan = await orchestrator.plan(requestDescription);
  console.log(`Plan: ${plan.subtasks.map((s) => s.id).join(" -> ")}\n`);

  const classifier = new TaskClassifier({
    rules: DEFAULT_CLASSIFICATION_RULES,
    llmClient: new AnthropicClassifierClient({ apiKey }),
  });
  // Scratch, per-run router state -- a single pilot instance shouldn't pollute (or draw
  // learned bandit history from) this repo's own real router-state.sqlite.
  const routerStore = new SqliteRouterStore(join(workspaceRoot, ".tmh-bench-router-state.sqlite"));
  const bandit = loadRouterState(routerStore);
  const rewardCollector = new RewardCollector({
    judgeClient: new AnthropicJudgeClient({
      apiKey,
      onVerdict: (verdict) =>
        console.log(`Judge verdict: ${verdict.score.toFixed(2)} (${verdict.confidence}) -- ${verdict.rationale}`),
    }),
  });
  const modelClientFactory = new AnthropicModelClientFactory({ apiKey });
  const tools = [
    createReadFileTool(workspaceRoot),
    createListDirectoryTool(workspaceRoot),
    createWriteFileTool(workspaceRoot),
    createEditFileTool(workspaceRoot),
    createRunCommandTool(workspaceRoot),
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
    new AnthropicEscalationClient({ apiKey }),
    {
      systemPrompt: SYSTEM_PROMPT,
      // Matches demo-real.ts: a subtask that needs to explore before it can act can easily need
      // more than the Executor default of 10 turns.
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
  const knownIds = new Set(plan.subtasks.map((s) => s.id));
  let subtaskCount = 0;

  for (;;) {
    while (!orchestrator.isComplete(completed)) {
      for (const subtask of orchestrator.getReadySubtasks(completed)) {
        console.log(`--- Subtask "${subtask.id}": ${subtask.description} ---`);
        const { output, reward, escalatedAfterFailure } = await runner.run(subtask, outputs);
        subtaskCount += 1;
        console.log(`Final: "${output.finalText}"`);
        console.log(`Reward: ${reward.toFixed(2)}${escalatedAfterFailure ? " (after escalation retry)" : ""}\n`);
        outputs.set(subtask.id, output);
        allOutputs.push(output);
        completed.add(subtask.id);
      }
    }

    console.log("Checking whether the plan needs additional subtasks...");
    const merged = await orchestrator.replan(requestDescription, allOutputs);
    const newSubtasks = merged.subtasks.filter((subtask) => !knownIds.has(subtask.id));
    if (newSubtasks.length === 0) {
      console.log("Replanning found no further work needed.\n");
      break;
    }
    for (const subtask of newSubtasks) knownIds.add(subtask.id);
  }

  routerStore.close();
  const wallClockMs = Date.now() - startedAt;

  const summary = {
    workspaceRoot,
    wallClockMs,
    subtaskCount,
    apiCalls: usage.apiCalls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    finalOutputs: allOutputs.map((o) => ({ subtaskId: o.subtaskId, finalText: o.finalText })),
  };
  await writeFile(outputJsonPath, JSON.stringify(summary, null, 2));
  console.log(
    `\nDone in ${(wallClockMs / 1000).toFixed(1)}s -- ${usage.inputTokens} fresh-in / ` +
      `${usage.cacheCreationInputTokens} cache-write / ${usage.cacheReadInputTokens} cache-read / ` +
      `${usage.outputTokens} out tokens across ${usage.apiCalls} API calls.`
  );
  console.log(`Summary written to ${outputJsonPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
