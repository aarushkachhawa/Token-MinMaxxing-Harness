/**
 * Run one ad-hoc task through the real pipeline (real model, real tools, real reward incl.
 * judge) without going through the orchestrator's fixed 3-step scripted plan -- lets you throw
 * any task description at it directly, including adversarial ones aimed at the tool sandbox.
 *
 * Spends real tokens every time it runs.
 * Usage: npm run stress -- "your task description" [--always-judge]
 */
import { DEFAULT_CLASSIFICATION_RULES, ScriptedClassifierClient, TaskClassifier } from "./classifier/index.js";
import { getAnthropicApiKey } from "./config/env.js";
import { ContextCompiler } from "./context/index.js";
import { AnthropicModelClient } from "./executor/anthropic-model-client.js";
import { AnthropicJudgeClient } from "./reward/anthropic-judge-client.js";
import { RewardCollector } from "./reward/reward-collector.js";
import { Router } from "./router/bandit.js";
import { ScriptedEscalationClient } from "./router/escalation.js";
import { SubtaskRunner } from "./runner/index.js";
import { createListDirectoryTool, createReadFileTool } from "./tools/index.js";

const SYSTEM_PROMPT =
  "You are a careful coding assistant working in this project's repository. Use " +
  "list_directory to explore the project structure and read_file to see a file's contents " +
  "(both take paths relative to the project root). Be brief but complete.";

const DEFAULT_TASK = "list the test files in src/reward and summarize what proxy-signals.ts checks for";

async function main() {
  const args = process.argv.slice(2);
  const alwaysJudge = args.includes("--always-judge");
  const description = args.filter((arg) => arg !== "--always-judge").join(" ") || DEFAULT_TASK;

  console.log(`\nTask: "${description}"${alwaysJudge ? " (judge forced to always sample)" : ""}\n`);

  const classifier = new TaskClassifier({
    rules: DEFAULT_CLASSIFICATION_RULES,
    llmClient: new ScriptedClassifierClient(["exploration"]),
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
  const modelClient = new AnthropicModelClient({ apiKey: getAnthropicApiKey() });
  const tools = [createReadFileTool(process.cwd()), createListDirectoryTool(process.cwd())];
  const contextCompiler = new ContextCompiler();

  const runner = new SubtaskRunner(
    bandit,
    classifier,
    rewardCollector,
    modelClient,
    tools,
    contextCompiler,
    new ScriptedEscalationClient(Array(10).fill("smart-expensive")),
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
