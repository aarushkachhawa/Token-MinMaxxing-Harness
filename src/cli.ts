#!/usr/bin/env node
/**
 * Genuinely interactive terminal CLI for the real pipeline -- same wiring as demo-real.ts
 * (AnthropicOrchestratorClient, TaskClassifier, SqliteRouterStore-backed bandit, RewardCollector,
 * AnthropicModelClient, the three real tools, SubtaskRunner), but instead of running a single
 * request from argv and exiting, it opens a REPL (`> `) that keeps the pipeline's long-lived
 * dependencies (router state, bandit, tools) alive across every request typed in, until /exit.
 *
 * Usage: npm run cli   (or, once built/linked, just `tmh`)
 */
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { AnthropicClassifierClient, DEFAULT_CLASSIFICATION_RULES, TaskClassifier } from "./classifier/index.js";
import { getAnthropicApiKey } from "./config/env.js";
import { ContextCompiler, type SubtaskOutput } from "./context/index.js";
import { AnthropicModelClient } from "./executor/anthropic-model-client.js";
import { AnthropicOrchestratorClient, Orchestrator } from "./orchestrator/index.js";
import { loadRouterState, saveRouterState, SqliteRouterStore } from "./persistence/index.js";
import { AnthropicJudgeClient } from "./reward/anthropic-judge-client.js";
import { RewardCollector } from "./reward/reward-collector.js";
import { ProgressUI } from "./progress-ui.js";
import { AnthropicEscalationClient } from "./router/anthropic-escalation-client.js";
import { SubtaskRunner } from "./runner/index.js";
import {
  createListDirectoryTool,
  createReadFileTool,
  createWriteFileTool,
  interactiveWriteApprovalGate,
} from "./tools/index.js";

try {
  process.loadEnvFile();
} catch {
  // no .env in cwd -- getAnthropicApiKey() will surface a clear error if the key is missing
}

const ROUTER_STATE_PATH = join(process.cwd(), "router-state.sqlite");

const SYSTEM_PROMPT =
  "You are a careful coding assistant working in this project's repository. Use " +
  "list_directory to explore the project structure and read_file to see a file's contents " +
  "(both take paths relative to the project root) -- don't assume a file exists if you " +
  "haven't found or read it. write_file is available to create or overwrite files, but every " +
  "write requires explicit human approval before it takes effect, so don't be surprised if a " +
  "write is rejected. If prior work is provided below, treat it as established fact rather " +
  "than re-investigating it. Be brief.";

interface PipelineDeps {
  orchestratorClient: AnthropicOrchestratorClient;
  classifier: TaskClassifier;
  routerStore: SqliteRouterStore;
  bandit: ReturnType<typeof loadRouterState>;
  runner: SubtaskRunner;
  progressUI: ProgressUI;
}

function printHelp(): void {
  console.log(
    [
      "Commands:",
      "  /help          show this help",
      "  /exit, /quit   exit the CLI",
      "While a request is running, press 'e' to expand/collapse the detailed progress view.",
    ].join("\n")
  );
}

/**
 * Runs one request through the full pipeline: fresh Orchestrator + fresh per-request state
 * (knownIds/completed/allOutputs/outputs), then the same ready-subtask + replan loop as
 * demo-real.ts. Long-lived deps (router store/bandit, classifier, runner, etc.) are shared
 * across calls so router learning accumulates across the whole interactive session.
 *
 * Collapsed mode shows *only* the spinner for the entire request -- no interleaved lines, since
 * that broke the point of collapsing in the first place. Everything that happens along the way
 * (plan, subtask headers, rewards, replan checks, triage/exploration/judge chatter) goes through
 * progressUI, which only surfaces it in the expanded box (press 'e'). The one thing that always
 * prints regardless of expand state is the actual deliverable: each subtask's answer text, once
 * the whole request has finished.
 */
async function runRequest(requestDescription: string, deps: PipelineDeps): Promise<void> {
  const { orchestratorClient, routerStore, bandit, runner, progressUI } = deps;

  try {
    progressUI.start("Thinking...");
    const orchestrator = new Orchestrator(orchestratorClient);
    const plan = await orchestrator.plan(requestDescription);
    progressUI.log(`Plan: ${plan.subtasks.map((s) => s.id).join(" -> ")}`);

    const outputs = new Map<string, SubtaskOutput>();
    const completed = new Set<string>();
    const allOutputs: SubtaskOutput[] = [];
    const knownIds = new Set(plan.subtasks.map((s) => s.id));

    for (;;) {
      while (!orchestrator.isComplete(completed)) {
        for (const subtask of orchestrator.getReadySubtasks(completed)) {
          progressUI.log(`--- Subtask "${subtask.id}": ${subtask.description} ---`);
          if (subtask.dependsOn.length > 0) {
            progressUI.log(`Context from: ${subtask.dependsOn.join(", ")}`);
          }

          progressUI.setStep(`Running "${subtask.id}"...`);
          const { output, reward, escalatedAfterFailure } = await runner.run(subtask, outputs);

          progressUI.log(`Reward: ${reward.toFixed(2)}${escalatedAfterFailure ? " (after escalation retry)" : ""}`);

          outputs.set(subtask.id, output);
          allOutputs.push(output);
          completed.add(subtask.id);
          // save after every subtask, not just at the end -- a crash mid-request shouldn't lose
          // what was already learned from the subtasks that did complete.
          saveRouterState(bandit, routerStore);
        }
      }

      progressUI.setStep("Checking for additional work...");
      const merged = await orchestrator.replan(requestDescription, allOutputs);
      const newSubtasks = merged.subtasks.filter((subtask) => !knownIds.has(subtask.id));

      if (newSubtasks.length === 0) {
        progressUI.log("Replanning found no further work needed.");
        break;
      }

      progressUI.log(
        `Replanning added ${newSubtasks.length} new subtask(s): ${newSubtasks.map((s) => s.id).join(", ")}`
      );
      for (const subtask of newSubtasks) {
        knownIds.add(subtask.id);
      }
    }

    progressUI.stop();
    for (const output of allOutputs) {
      console.log(output.finalText);
      console.log();
    }
  } finally {
    // Safety net: if something threw mid-phase, this guarantees the spinner/raw mode gets torn
    // down (stop() is a safe no-op if already stopped) instead of leaking into the next prompt.
    progressUI.stop();
  }
}

async function main() {
  console.log("Token-Maxxing-Harness CLI");
  console.log("Type a request, /help for commands, /exit to quit.\n");

  const progressUI = new ProgressUI();

  // Build all long-lived pipeline dependencies once, before the REPL loop starts, and reuse
  // them across every request typed into the REPL.
  const orchestratorClient = new AnthropicOrchestratorClient({
    apiKey: getAnthropicApiKey(),
    workspaceRoot: process.cwd(),
    onTriage: (triage) => {
      progressUI.setStep(triage.needsExploration ? "Exploring repo..." : "Planning...");
      progressUI.log(`Triage: needsExploration=${triage.needsExploration} -- ${triage.reasoning}`);
    },
    onExploration: (summary) => {
      progressUI.setStep("Planning...");
      progressUI.log(`Exploration summary: ${summary}`);
    },
  });

  const classifier = new TaskClassifier({
    rules: DEFAULT_CLASSIFICATION_RULES,
    llmClient: new AnthropicClassifierClient({ apiKey: getAnthropicApiKey() }),
  });
  // Router state persists across runs in a SQLite file at the repo root, and now also
  // accumulates learning across an entire interactive session rather than resetting per request.
  const routerStore = new SqliteRouterStore(ROUTER_STATE_PATH);
  const bandit = loadRouterState(routerStore);
  const rewardCollector = new RewardCollector({
    judgeClient: new AnthropicJudgeClient({
      apiKey: getAnthropicApiKey(),
      onVerdict: (verdict) =>
        progressUI.log(
          `Judge verdict: ${verdict.score.toFixed(2)} (${verdict.confidence}) -- ${verdict.rationale}`
        ),
    }),
  });
  const modelClient = new AnthropicModelClient({ apiKey: getAnthropicApiKey() });
  const tools = [
    createReadFileTool(process.cwd()),
    createListDirectoryTool(process.cwd()),
    createWriteFileTool(process.cwd(), {
      // The approval gate opens its own readline interface on stdin -- withPaused() releases the
      // spinner's raw-mode keypress listener first so the two never fight over input.
      onBeforeWrite: (info) => progressUI.withPaused(() => interactiveWriteApprovalGate(info)),
    }),
  ];
  const contextCompiler = new ContextCompiler();

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
      executorMaxTurns: 15,
      hybridRouterOptions: { minPullsBeforeConfident: 3 },
      onCategoryDiscovered: (category) => {
        if (bandit.getCandidates(category).length === 0) {
          bandit.register(category, "fast-cheap", 0.01);
          bandit.register(category, "smart-expensive", 0.3);
        }
      },
    }
  );

  const deps: PipelineDeps = { orchestratorClient, classifier, routerStore, bandit, runner, progressUI };

  const cleanup = () => {
    progressUI.stop();
    routerStore.close();
  };
  process.on("SIGINT", () => {
    console.log("\nExiting.");
    cleanup();
    process.exit(0);
  });

  // One readline interface serves any number of consecutive questions (/help, blank lines, a
  // pasted or piped multi-line batch) -- closing and recreating it on *every* line is what broke
  // this originally: Node delivers a piped/pasted multi-line chunk to the interface in one shot,
  // and closing the interface right after the first line discards the rest of that chunk instead
  // of leaving it for the next question. We only close it around runRequest(), since that's the
  // one window where interactiveWriteApprovalGate might need to open its own interface on stdin
  // and two concurrently-open interfaces on the same stream would fight over input.
  let rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const line = (await rl.question("> ")).trim();

    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") {
      printHelp();
      continue;
    }

    rl.close();
    try {
      await runRequest(line, deps);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
    }
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  rl.close();
  cleanup();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
