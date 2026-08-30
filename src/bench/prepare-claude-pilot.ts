/**
 * Prepares every pinned pilot instance for the Claude Code side of the comparison: fresh checkout
 * + problem statement written to disk per instance, in the same <instance>/{repo,problem.txt}
 * layout run-tmh-pilot.ts uses. Pure git/filesystem work -- no `claude` invocation, so this half
 * runs fine as me; only scripts/run-claude-pilot.sh (the part that actually calls `claude -p`)
 * needs to run in the user's own terminal.
 *
 * Usage: tsx src/bench/prepare-claude-pilot.ts <pilotInstancesJson> <workDir>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkoutInstance } from "./git-checkout.js";
import { loadPilotInstances } from "./swebench-loader.js";

async function main() {
  const [pilotInstancesJson, workDir] = process.argv.slice(2);
  if (!pilotInstancesJson || !workDir) {
    console.error("Usage: prepare-claude-pilot.ts <pilotInstancesJson> <workDir>");
    process.exitCode = 1;
    return;
  }

  const instances = await loadPilotInstances(pilotInstancesJson);
  const cacheDir = join(workDir, "_repo-cache");
  await mkdir(workDir, { recursive: true });

  for (const [index, instance] of instances.entries()) {
    console.log(`[${index + 1}/${instances.length}] Preparing ${instance.instanceId}...`);
    const instanceDir = join(workDir, instance.instanceId);
    await mkdir(instanceDir, { recursive: true });
    await checkoutInstance(instance.repo, instance.baseCommit, cacheDir, join(instanceDir, "repo"));
    await writeFile(join(instanceDir, "problem.txt"), instance.problemStatement);
  }

  console.log(`\nAll ${instances.length} instances checked out under ${workDir}.`);
  console.log(`Next: run scripts/run-claude-pilot.sh ${workDir} yourself in your own terminal.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
