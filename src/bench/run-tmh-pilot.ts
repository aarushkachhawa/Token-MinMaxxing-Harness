/**
 * Drives this harness through every pinned pilot instance: fresh checkout -> run-instance.ts (a
 * separate process per instance, so one instance's fetch-usage-tracker/router-state/SQLite handle
 * never leaks into the next) -> git diff -> append to the shared predictions file + per-instance
 * log. This is the tmh side of the pilot; the Claude Code side can't be driven from here (a nested
 * `claude -p` invocation gets blocked by the permission classifier), so it has its own separate
 * driver the user runs themselves -- see prepare-claude-pilot.ts / scripts/run-claude-pilot.sh.
 *
 * Usage: tsx --env-file=.env src/bench/run-tmh-pilot.ts <pilotInstancesJson> <workDir> <predictionsOutPath> <logOutPath>
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkoutInstance, diffInstance } from "./git-checkout.js";
import { loadPilotInstances } from "./swebench-loader.js";
import type { InstanceRunLog } from "./types.js";

const MODEL_NAME_OR_PATH = "tmh-pilot";

function runInstanceScript(workspace: string, requestFile: string, outputJson: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "src/bench/run-instance.ts", workspace, requestFile, outputJson], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`run-instance.ts exited with code ${code} for workspace ${workspace}`));
    });
    child.on("error", reject);
  });
}

async function main() {
  const [pilotInstancesJson, workDir, predictionsOutPath, logOutPath] = process.argv.slice(2);
  if (!pilotInstancesJson || !workDir || !predictionsOutPath || !logOutPath) {
    console.error("Usage: run-tmh-pilot.ts <pilotInstancesJson> <workDir> <predictionsOutPath> <logOutPath>");
    process.exitCode = 1;
    return;
  }

  const instances = await loadPilotInstances(pilotInstancesJson);
  const cacheDir = join(workDir, "_repo-cache");
  await mkdir(workDir, { recursive: true });
  // Truncate any previous run's output before appending fresh results.
  await writeFile(predictionsOutPath, "");
  await writeFile(logOutPath, "");

  for (const [index, instance] of instances.entries()) {
    console.log(`\n=== [${index + 1}/${instances.length}] ${instance.instanceId} ===`);
    const instanceDir = join(workDir, instance.instanceId);
    const repoDir = join(instanceDir, "repo");
    const requestFile = join(instanceDir, "problem.txt");
    const resultJson = join(instanceDir, "result.json");

    await mkdir(instanceDir, { recursive: true });
    await checkoutInstance(instance.repo, instance.baseCommit, cacheDir, repoDir);
    await writeFile(requestFile, instance.problemStatement);

    const startedAt = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      await runInstanceScript(repoDir, requestFile, resultJson);
      const summary = JSON.parse(await readFile(resultJson, "utf-8"));
      inputTokens = summary.inputTokens ?? 0;
      outputTokens = summary.outputTokens ?? 0;
    } catch (error) {
      console.error(`Run failed for ${instance.instanceId}:`, error);
    }
    const wallClockMs = Date.now() - startedAt;

    const patch = await diffInstance(repoDir);
    await appendFile(
      predictionsOutPath,
      JSON.stringify({ instance_id: instance.instanceId, model_name_or_path: MODEL_NAME_OR_PATH, model_patch: patch }) + "\n"
    );

    const log: InstanceRunLog = {
      instanceId: instance.instanceId,
      wallClockMs,
      inputTokens,
      outputTokens,
      costUsd: null, // tmh doesn't get a directly-billed total the way Claude Code's result.json does
      patchIsEmpty: patch.trim().length === 0,
    };
    await appendFile(logOutPath, JSON.stringify(log) + "\n");
    console.log(
      `${instance.instanceId}: ${(wallClockMs / 1000).toFixed(1)}s, ${inputTokens} in / ${outputTokens} out tokens, patch ${
        log.patchIsEmpty ? "EMPTY" : "non-empty"
      }`
    );
  }

  console.log(`\nDone. Predictions: ${predictionsOutPath}, log: ${logOutPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
