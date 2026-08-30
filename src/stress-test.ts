/**
 * Run one ad-hoc task through the real pipeline (real model, real tools, real reward incl.
 * judge) without going through the orchestrator's fixed 3-step scripted plan -- lets you throw
 * any task description at it directly, including adversarial ones aimed at the tool sandbox.
 *
 * Spends real tokens every time it runs.
 * Usage: npm run stress -- "your task description" [--always-judge]
 */
import { BudgetGovernor } from "./budget/index.js";
import { AnthropicClassifierClient, DEFAULT_CLASSIFICATION_RULES, TaskClassifier } from "./classifier/index.js";
import { getAnthropicApiKey } from "./config/env.js";
import { ContextCompiler } from "./context/index.js";
import { AnthropicModelClientFactory } from "./executor/anthropic-model-client-factory.js";
import { AnthropicJudgeClient } from "./reward/anthropic-judge-client.js";
import { RewardCollector } from "./reward/reward-collector.js";
import { AnthropicEscalationClient } from "./router/anthropic-escalation-client.js";
import { Router } from "./router/bandit.js";
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

const SYSTEM_PROMPT =
  "You are a careful coding assistant working in this project's repository. Use " +
  "list_directory to explore the project structure and read_file to see a file's contents " +
  "(both take paths relative to the project root). Prefer edit_file for a targeted change to " +
  "an existing file; use write_file only to create a new file or replace one entirely. " +
  "run_command runs a shell command in the project root -- use it to verify your work actually " +
  "functions before claiming it's done. Every write, edit, or command requires explicit human " +
  "approval before it takes effect. Be brief but complete.";

const DEFAULT_TASK = "list the test files in src/reward and summarize what proxy-signals.ts checks for";
// Real, constructable model ids -- these ARE what gets registered as bandit arms below, so
// whatever the router picks is what AnthropicModelClientFactory can actually build a client for.
const FAST_CHEAP_MODEL_ID = "claude-haiku-4-5-20251001";
const SMART_EXPENSIVE_MODEL_ID = "claude-sonnet-5";
// See cli.ts for the reasoning behind this default -- a single-task run rarely gets close to it.
const TARGET_TOKENS_PER_MINUTE = 200_000;

async function main() {
  const args = process.argv.slice(2);
  const alwaysJudge = args.includes("--always-judge");
  const description = args.filter((arg) => arg !== "--always-judge").join(" ") || DEFAULT_TASK;

  console.log(`\nTask: "${description}"${alwaysJudge ? " (judge forced to always sample)" : ""}\n`);

  const classifier = new TaskClassifier({
    rules: DEFAULT_CLASSIFICATION_RULES,
    llmClient: new AnthropicClassifierClient({ apiKey: getAnthropicApiKey() }),
  });
  const bandit = new Router();
  const rewardCollector = new RewardCollector({
    judgeClient: new AnthropicJudgeClient({
      apiKey: getAnthropicApiKey(),
      onVerdict: (verdict) =>
        console.log(
          `Judge verdict: ${verdict.score.toFixed(2)} (${verdict.confidence}) -- ${verdict.rationale}`
        ),
    }),
    judgeSampleRate: alwaysJudge ? 1 : undefined,
  });
  const modelClientFactory = new AnthropicModelClientFactory({ apiKey: getAnthropicApiKey() });
  // Same interactive approval gates as demo-real.ts -- this script deliberately throws
  // adversarial tasks at the real tool sandbox, so every mutating tool staying gated here (not
  // just in demo-real.ts) is the point, not an afterthought.
  const tools = [
    createReadFileTool(process.cwd()),
    createListDirectoryTool(process.cwd()),
    createWriteFileTool(process.cwd(), { onBeforeWrite: interactiveWriteApprovalGate }),
    createEditFileTool(process.cwd(), { onBeforeWrite: interactiveEditApprovalGate }),
    createRunCommandTool(process.cwd(), { onBeforeExecute: interactiveRunCommandApprovalGate }),
  ];
  const contextCompiler = new ContextCompiler();
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

  const { output, reward, escalatedAfterFailure } = await runner.run(
    { id: "adhoc", description, dependsOn: [], highRisk: false },
    new Map()
  );

  console.log(`\nFinal: "${output.finalText}"`);
  console.log(`Reward: ${reward.toFixed(2)}${escalatedAfterFailure ? " (after escalation retry)" : ""}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
