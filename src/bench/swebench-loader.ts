/**
 * Loads pinned pilot instances from SWE-bench Lite via HuggingFace's datasets-server rows API --
 * plain `fetch`, no Python dependency. `offset=0&length=<count>` reproduces the exact same
 * dataset-order slice the pilot was originally pinned from (`ds[i]` for i in range(20) in Python
 * during setup): row_idx 0 is astropy__astropy-12907 in both, so re-fetching here reproduces the
 * identical 20-instance pilot rather than a fresh, incomparable sample.
 *
 * Usage: tsx src/bench/swebench-loader.ts <outputPath> [count]
 */
import { readFile, writeFile } from "node:fs/promises";
import type { SweBenchInstance } from "./types.js";

const ROWS_URL = "https://datasets-server.huggingface.co/rows?dataset=SWE-bench%2FSWE-bench_Lite&config=default&split=test";

interface HfRow {
  row: {
    instance_id: string;
    repo: string;
    base_commit: string;
    problem_statement: string;
  };
}

export async function fetchPilotInstances(count = 20): Promise<SweBenchInstance[]> {
  const response = await fetch(`${ROWS_URL}&offset=0&length=${count}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch SWE-bench Lite rows: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { rows: HfRow[] };
  return body.rows.map(({ row }) => ({
    instanceId: row.instance_id,
    repo: row.repo,
    baseCommit: row.base_commit,
    problemStatement: row.problem_statement,
  }));
}

export async function savePilotInstances(instances: SweBenchInstance[], path: string): Promise<void> {
  await writeFile(path, JSON.stringify(instances, null, 2));
}

export async function loadPilotInstances(path: string): Promise<SweBenchInstance[]> {
  return JSON.parse(await readFile(path, "utf-8")) as SweBenchInstance[];
}

async function main() {
  const [outputPath, countArg] = process.argv.slice(2);
  if (!outputPath) {
    console.error("Usage: swebench-loader.ts <outputPath> [count]");
    process.exitCode = 1;
    return;
  }
  const count = countArg ? Number.parseInt(countArg, 10) : 20;
  const instances = await fetchPilotInstances(count);
  await savePilotInstances(instances, outputPath);
  console.log(`Wrote ${instances.length} pinned instances to ${outputPath}:`);
  for (const instance of instances) console.log(`  ${instance.instanceId}`);
}

// Only run as a CLI when invoked directly (tsx src/bench/swebench-loader.ts ...), not when
// imported by run-tmh-pilot.ts / prepare-claude-pilot.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
