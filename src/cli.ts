#!/usr/bin/env node
/**
 * Genuinely interactive terminal CLI for the real pipeline -- same wiring as demo-real.ts
 * (AnthropicOrchestratorClient, TaskClassifier, SqliteRouterStore-backed bandit, RewardCollector,
 * AnthropicModelClientFactory, the five real tools, SubtaskRunner), but instead of running a single
 * request from argv and exiting, it opens a REPL (`> `) that keeps the pipeline's long-lived
 * dependencies (router state, bandit, tools) alive across every request typed in, until /exit.
 * Also remembers the session's conversation so a follow-up like "now do the same for the other
 * file" resolves correctly -- see conversationHistory in PipelineDeps and runRequest(); /reset
 * clears it without losing router state or exiting.
 *
 * Usage: npm run cli   (or, once built/linked, just `tmh`)
 */
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { BudgetGovernor } from "./budget/index.js";
import { AnthropicClassifierClient, DEFAULT_CLASSIFICATION_RULES, TaskClassifier } from "./classifier/index.js";
import { drawBanner, formatResponse, theme } from "./cli-theme.js";
import { getAnthropicApiKey } from "./config/env.js";
import { ContextCompiler, type SubtaskOutput } from "./context/index.js";
import { AnthropicModelClientFactory } from "./executor/anthropic-model-client-factory.js";
import { FramedPrompt } from "./framed-prompt.js";
import { type ConversationSummarizerClient, AnthropicConversationSummarizerClient } from "./memory/index.js";
import {
  AnthropicOrchestratorClient,
  findTurnsNeedingSummary,
  Orchestrator,
  type ConversationTurn,
} from "./orchestrator/index.js";
import { loadRouterState, saveRouterState, SqliteRouterStore } from "./persistence/index.js";
import { AnthropicJudgeClient } from "./reward/anthropic-judge-client.js";
import { RewardCollector } from "./reward/reward-collector.js";
import { ProgressUI } from "./progress-ui.js";
import { AnthropicEscalationClient } from "./router/anthropic-escalation-client.js";
import { SubtaskRunner } from "./runner/index.js";
import {
  createEditFileTool,
  createListDirectoryTool,
  createReadFileTool,
  createRunCommandTool,
  createWriteFileTool,
  interactiveEditApprovalGate,
  interactiveRunCommandApprovalGate,
  interactiveWriteApprovalGate,
} from "./tools/index.js";

try {
  process.loadEnvFile();
} catch {
  // no .env in cwd -- getAnthropicApiKey() will surface a clear error if the key is missing
}

const ROUTER_STATE_PATH = join(process.cwd(), "router-state.sqlite");
// Real, constructable model ids -- these ARE what gets registered as bandit arms below, so
// whatever the router picks is what AnthropicModelClientFactory can actually build a client for.
const FAST_CHEAP_MODEL_ID = "claude-haiku-4-5-20251001";
const SMART_EXPENSIVE_MODEL_ID = "claude-sonnet-5";
// Burn-rate target the budget governor throttles routing against once exceeded -- generous enough
// that ordinary interactive use (a handful of subtasks a minute) never triggers cost throttling on
// its own; only a sustained heavy burn rate (many large or escalated subtasks back to back) pushes
// costWeight up. A starting point, not derived from real usage data yet.
const TARGET_TOKENS_PER_MINUTE = 200_000;

const SYSTEM_PROMPT =
  "You are a careful coding assistant working in this project's repository. Use " +
  "list_directory to explore the project structure and read_file to see a file's contents " +
  "(both take paths relative to the project root) -- don't assume a file exists if you " +
  "haven't found or read it. Prefer edit_file for a targeted change to an existing file -- it " +
  "only needs the exact excerpt that's changing, not the whole file; use write_file only to " +
  "create a new file or replace one entirely. run_command runs a shell command in the project " +
  "root -- use it to actually run tests, check that something imports cleanly, or reproduce a " +
  "bug before you claim it's fixed. A fix you never ran is not a finished task. Every write, " +
  "edit, or command requires explicit human approval before it takes effect, so don't be " +
  "surprised if one is rejected. If prior work is provided below, treat it as established fact " +
  "rather than re-investigating it. Be brief.";

interface PipelineDeps {
  orchestratorClient: AnthropicOrchestratorClient;
  classifier: TaskClassifier;
  routerStore: SqliteRouterStore;
  bandit: ReturnType<typeof loadRouterState>;
  runner: SubtaskRunner;
  progressUI: ProgressUI;
  /**
   * Prior turns of this session, oldest first, mutated in place: runRequest() reads it (passed to
   * Orchestrator.plan() so a follow-up's vague references can be resolved) and appends to it once
   * the request completes. /reset clears it to start a new topic without losing router state.
   */
  conversationHistory: ConversationTurn[];
  /**
   * Set by orchestratorClient's onTriage callback during plan(), read by runRequest() right after
   * plan() resolves to decide whether this turn is worth appending to conversationHistory at all --
   * a shared mutable cell rather than a return value because AnthropicOrchestratorClient's public
   * decompose()/SubtaskPlan contract has no natural home for "was this worth remembering", and only
   * one runRequest() call is ever in flight at a time so there's no risk of it being stale.
   */
  lastTriage: { worthRemembering: boolean };
  summarizer: ConversationSummarizerClient;
}

function printHelp(): void {
  console.log(
    [
      theme.bold("Commands:"),
      `  ${theme.neon("/help")}          show this help`,
      `  ${theme.neon("/reset")}         forget conversation history and start a fresh topic`,
      `  ${theme.neon("/exit, /quit")}   exit the CLI`,
    ].join("\n")
  );
}

function printBanner(): void {
  console.log(
    drawBanner("TOKEN-MINMAXXING-HARNESS", "agentic coding harness · hybrid model router", [
      `${theme.neon("❯")} /help    ${theme.dim("show available commands")}`,
      `${theme.neon("❯")} /reset   ${theme.dim("clear conversation history")}`,
      `${theme.neon("❯")} /exit    ${theme.dim("quit")}`,
    ])
  );
  console.log();
}

/**
 * Runs one request through the full pipeline: fresh Orchestrator + fresh per-request state
 * (knownIds/completed/allOutputs/outputs), then the same ready-subtask + replan loop as
 * demo-real.ts. Long-lived deps (router store/bandit, classifier, runner, etc.) are shared
 * across calls so router learning accumulates across the whole interactive session.
 *
 * progressUI prints one line per distinct step (plan, subtask headers, rewards, replan checks) as
 * the request moves through them -- see progress-ui.ts. The detail log (triage/exploration/judge
 * chatter, etc.) that used to go through progressUI.log() is currently swallowed there rather
 * than printed; the one thing that always prints is the actual deliverable: each subtask's answer
 * text, once the whole request has finished.
 *
 * deps.conversationHistory carries prior turns into Orchestrator.plan() so a follow-up like "now
 * do the same for the other file" resolves against what was actually asked/answered before, and
 * this request's own answer is appended to it once it completes -- see AnthropicOrchestratorClient
 * for where that history actually gets used (triage/explore/structure prompts).
 */
async function runRequest(requestDescription: string, deps: PipelineDeps): Promise<void> {
  const { orchestratorClient, routerStore, bandit, runner, progressUI, conversationHistory, lastTriage, summarizer } =
    deps;

  try {
    progressUI.start("Thinking...");
    if (conversationHistory.length > 0) {
      progressUI.log(`Using ${conversationHistory.length} prior turn(s) of context.`);
    }
    const orchestrator = new Orchestrator(orchestratorClient);
    const plan = await orchestrator.plan(requestDescription, conversationHistory);
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
    const finalText = allOutputs.map((output) => output.finalText).join("\n\n");
    console.log(formatResponse(finalText));
    console.log();
    // Recorded after the request actually finishes -- if runRequest throws above, this turn never
    // gets appended, since there's no coherent "answer" to remember for a failed request. Also
    // skipped when triage judged this a one-off aside (see TriageResult.worthRemembering) -- the
    // request still ran and got answered above either way, it just doesn't stick around to
    // potentially confuse a later "it"/"that" in an unrelated follow-up.
    if (lastTriage.worthRemembering) {
      conversationHistory.push({ requestDescription, finalText });
    }

    // Runs after the answer is already on screen, so this never delays it -- a turn that just
    // aged out of formatConversationHistory's recent-detail window gets compressed into a real
    // summary (once, cached on the turn itself) instead of falling back to a bare request-only
    // mention. Best-effort: a failure here just leaves the cheaper fallback in place for this
    // render, and the turn will be retried the next time something ages out.
    const needsSummary = findTurnsNeedingSummary(conversationHistory);
    if (needsSummary.length > 0) {
      try {
        progressUI.start("Compacting older context...");
        for (const turn of needsSummary) {
          turn.summary = await summarizer.summarize(turn);
        }
      } catch (err) {
        console.error(
          "Warning: conversation summarization failed, keeping the plain-text fallback:",
          err instanceof Error ? err.message : err
        );
      } finally {
        progressUI.stop();
      }
    }
  } finally {
    // Safety net: if something threw mid-phase, this guarantees the spinner/raw mode gets torn
    // down (stop() is a safe no-op if already stopped) instead of leaking into the next prompt.
    progressUI.stop();
  }
}

async function main() {
  printBanner();

  const progressUI = new ProgressUI();
  // Defaults true so a request that somehow completes without triage ever firing (shouldn't
  // happen in practice) still gets remembered rather than silently dropped.
  const lastTriage: { worthRemembering: boolean } = { worthRemembering: true };

  // Build all long-lived pipeline dependencies once, before the REPL loop starts, and reuse
  // them across every request typed into the REPL.
  const orchestratorClient = new AnthropicOrchestratorClient({
    apiKey: getAnthropicApiKey(),
    workspaceRoot: process.cwd(),
    onTriage: (triage) => {
      lastTriage.worthRemembering = triage.worthRemembering;
      progressUI.setStep(triage.needsExploration ? "Exploring repo..." : "Planning...");
      progressUI.log(
        `Triage: needsExploration=${triage.needsExploration}, worthRemembering=${triage.worthRemembering} -- ${triage.reasoning}`
      );
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
  const modelClientFactory = new AnthropicModelClientFactory({ apiKey: getAnthropicApiKey() });
  // Every approval gate opens its own readline interface on stdin -- withPaused() releases the
  // spinner's raw-mode keypress listener first so the two never fight over input.
  const tools = [
    createReadFileTool(process.cwd()),
    createListDirectoryTool(process.cwd()),
    createWriteFileTool(process.cwd(), {
      onBeforeWrite: (info) => progressUI.withPaused(() => interactiveWriteApprovalGate(info)),
    }),
    createEditFileTool(process.cwd(), {
      onBeforeWrite: (info) => progressUI.withPaused(() => interactiveEditApprovalGate(info)),
    }),
    createRunCommandTool(process.cwd(), {
      onBeforeExecute: (info) => progressUI.withPaused(() => interactiveRunCommandApprovalGate(info)),
    }),
  ];
  const contextCompiler = new ContextCompiler();
  // One instance shared across every subtask in the session, so burn-rate reflects the session's
  // real cumulative spend (cache-discounted -- see BudgetGovernor.recordSpend) rather than
  // resetting per request.
  const budgetGovernor = new BudgetGovernor(TARGET_TOKENS_PER_MINUTE);

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
      executorMaxTurns: 15,
      hybridRouterOptions: { minPullsBeforeConfident: 3 },
      budgetGovernor,
      onCategoryDiscovered: (category) => {
        if (bandit.getCandidates(category).length === 0) {
          bandit.register(category, FAST_CHEAP_MODEL_ID, 0.01);
          bandit.register(category, SMART_EXPENSIVE_MODEL_ID, 0.3);
        }
      },
    }
  );

  const conversationHistory: ConversationTurn[] = [];
  const summarizer = new AnthropicConversationSummarizerClient({ apiKey: getAnthropicApiKey() });
  const deps: PipelineDeps = {
    orchestratorClient,
    classifier,
    routerStore,
    bandit,
    runner,
    progressUI,
    conversationHistory,
    lastTriage,
    summarizer,
  };

  // FramedPrompt draws a divider above and below the input row and reads raw keystrokes itself,
  // rather than going through Node's readline -- see framed-prompt.ts for why the two can't
  // coexist (readline erases everything below the cursor on every redraw, wiping a pre-drawn
  // frame before it's ever visible). It needs a real stdin TTY to put into raw mode, so piped/
  // non-interactive input (no interactive keystrokes to read in the first place) falls back to a
  // plain readline question with no framing, same as before FramedPrompt existed.
  const isFullyInteractive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const framedPrompt = isFullyInteractive ? new FramedPrompt() : null;
  // One readline interface serves any number of consecutive fallback questions (/help, blank
  // lines, a pasted or piped multi-line batch) -- closing and recreating it on *every* line is
  // what broke this originally: Node delivers a piped/pasted multi-line chunk to the interface in
  // one shot, and closing the interface right after the first line discards the rest of that
  // chunk instead of leaving it for the next question. We only close it around runRequest(),
  // since that's the one window where interactiveWriteApprovalGate might need to open its own
  // interface on stdin and two concurrently-open interfaces on the same stream would fight over
  // input. FramedPrompt needs no such dance: it always fully releases raw mode before ask()
  // resolves, well before runRequest() ever starts, so there's nothing left open to collide with.
  let fallbackRl = framedPrompt ? null : createInterface({ input: process.stdin, output: process.stdout });

  const cleanup = () => {
    progressUI.stop();
    framedPrompt?.release();
    routerStore.close();
  };
  process.on("SIGINT", () => {
    console.log("\nExiting.");
    cleanup();
    process.exit(0);
  });

  for (;;) {
    const line = (
      framedPrompt ? await framedPrompt.ask(`${theme.neon("❯")} `) : await fallbackRl!.question("> ")
    ).trim();

    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") {
      printHelp();
      continue;
    }
    if (line === "/reset") {
      conversationHistory.length = 0;
      console.log(theme.success("Conversation history cleared.\n"));
      continue;
    }

    fallbackRl?.close();
    try {
      await runRequest(line, deps);
    } catch (err) {
      console.error(theme.error("Error:"), err instanceof Error ? err.message : err);
    }
    if (!framedPrompt) fallbackRl = createInterface({ input: process.stdin, output: process.stdout });
  }

  fallbackRl?.close();
  cleanup();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
