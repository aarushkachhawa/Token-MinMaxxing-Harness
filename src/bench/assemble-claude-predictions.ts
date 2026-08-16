/**
 * Post-processes what scripts/run-claude-pilot.sh produced: for each pinned instance, reads its
 * result.json (Claude Code's own `total_cost_usd`/usage -- no fetch-wrapper estimate needed here,
 * it's directly billed) and `git diff`s its repo checkout, then writes the same two output shapes
 * run-tmh-pilot.ts does (predictions.jsonl + per-instance log.jsonl) so report.ts can treat both
 * agents symmetrically.
 *
 * Usage: tsx src/bench/assemble-claude-predictions.ts <pilotInstancesJson> <workDir> <predictionsOutPath> <logOutPath>
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diffInstance } from "./git-checkout.js";
import { loadPilotInstances } from "./swebench-loader.js";
import type { InstanceRunLog } from "./types.js";

const MODEL_NAME_OR_PATH = "claude-code-pilot";

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

async function main() {
  const [pilotInstancesJson, workDir, predictionsOutPath, logOutPath] = process.argv.slice(2);
  if (!pilotInstancesJson || !workDir || !predictionsOutPath || !logOutPath) {
    console.error("Usage: assemble-claude-predictions.ts <pilotInstancesJson> <workDir> <predictionsOutPath> <logOutPath>");
    process.exitCode = 1;
    return;
  }

  const instances = await loadPilotInstances(pilotInstancesJson);
  const predictionLines: string[] = [];
  const logLines: string[] = [];

  for (const instance of instances) {
    const instanceDir = join(workDir, instance.instanceId);
    const repoDir = join(instanceDir, "repo");
    const resultPath = join(instanceDir, "result.json");

    let result: ClaudeResult;
    try {
      result = JSON.parse(await readFile(resultPath, "utf-8"));
    } catch {
      console.warn(`No result.json for ${instance.instanceId} (did run-claude-pilot.sh reach it?) -- skipping`);
      continue;
    }

    const patch = await diffInstance(repoDir);
    predictionLines.push(
      JSON.stringify({ instance_id: instance.instanceId, model_name_or_path: MODEL_NAME_OR_PATH, model_patch: patch })
    );

    const usage = result.usage ?? {};
    const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    const log: InstanceRunLog = {
      instanceId: instance.instanceId,
      wallClockMs: result.duration_ms ?? 0,
      inputTokens,
      outputTokens: usage.output_tokens ?? 0,
      costUsd: result.total_cost_usd ?? null,
      patchIsEmpty: patch.trim().length === 0,
    };
    logLines.push(JSON.stringify(log));

    if (result.is_error) {
      console.warn(`${instance.instanceId}: result.json reports an error -- ${result.result ?? "(no message)"}`);
    }
  }

  await writeFile(predictionsOutPath, predictionLines.join("\n") + (predictionLines.length ? "\n" : ""));
  await writeFile(logOutPath, logLines.join("\n") + (logLines.length ? "\n" : ""));
  console.log(`Assembled ${predictionLines.length}/${instances.length} instances -> ${predictionsOutPath}, ${logOutPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
