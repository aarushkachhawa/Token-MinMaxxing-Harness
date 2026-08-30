/**
 * Aggregates one agent-vs-agent comparison from what everything upstream produced: each agent's
 * SWE-bench grader report (`<model_name_or_path>.<run_id>.json`, the ground truth for
 * resolved/unresolved -- never self-reported by either agent) plus its own per-instance log.jsonl
 * (tokens/wall-clock/cost from run-tmh-pilot.ts or assemble-claude-predictions.ts).
 *
 * Usage: tsx src/bench/report.ts <tmhReportJson> <tmhLogJsonl> <claudeReportJson> <claudeLogJsonl>
 */
import { readFile } from "node:fs/promises";
import type { InstanceRunLog } from "./types.js";

// tmh's log doesn't carry a per-instance billed cost (unlike Claude Code's result.json), since
// the fetch-usage-tracker in run-instance.ts totals tokens across all five Anthropic-backed
// clients without splitting by which model priced them. This blended rate is a floor estimate
// (Haiku 4.5 pricing, since the executor's tool-loop tokens dominate call volume) -- see the
// conversation's earlier cost discussion for why an exact split isn't available yet.
const TMH_ESTIMATED_INPUT_RATE_PER_M = 1;
const TMH_ESTIMATED_OUTPUT_RATE_PER_M = 5;

interface GraderReport {
  total_instances: number;
  resolved_instances: number;
  resolved_ids: string[];
  unresolved_ids: string[];
  empty_patch_ids: string[];
  error_ids: string[];
}

async function loadReport(path: string): Promise<GraderReport> {
  return JSON.parse(await readFile(path, "utf-8"));
}

async function loadLog(path: string): Promise<InstanceRunLog[]> {
  const text = await readFile(path, "utf-8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function summarize(label: string, report: GraderReport, log: InstanceRunLog[], estimateCost: boolean) {
  const resolvedSet = new Set(report.resolved_ids);
  const costs = log.map((l) =>
    l.costUsd ?? (estimateCost ? (l.inputTokens * TMH_ESTIMATED_INPUT_RATE_PER_M + l.outputTokens * TMH_ESTIMATED_OUTPUT_RATE_PER_M) / 1_000_000 : 0)
  );
  const totalCost = costs.reduce((a, b) => a + b, 0);
  const resolvedCount = report.resolved_instances;
  const costPerResolved = resolvedCount > 0 ? totalCost / resolvedCount : null;

  console.log(`\n${label}`);
  console.log("-".repeat(label.length));
  console.log(`Resolved:              ${resolvedCount}/${report.total_instances}`);
  console.log(`Empty-patch instances: ${report.empty_patch_ids.length}`);
  console.log(`Error instances:       ${report.error_ids.length}`);
  console.log(`Mean wall-clock:       ${(mean(log.map((l) => l.wallClockMs)) / 1000).toFixed(1)}s`);
  console.log(`Mean input tokens:     ${Math.round(mean(log.map((l) => l.inputTokens))).toLocaleString()}`);
  console.log(`Mean output tokens:    ${Math.round(mean(log.map((l) => l.outputTokens))).toLocaleString()}`);
  console.log(`Total cost:            $${totalCost.toFixed(2)}${estimateCost ? " (estimated)" : ""}`);
  console.log(
    `Cost per resolved:     ${costPerResolved === null ? "n/a (nothing resolved)" : `$${costPerResolved.toFixed(2)}${estimateCost ? " (estimated)" : ""}`}`
  );

  return { resolvedSet, resolvedCount, total: report.total_instances, totalCost, costPerResolved };
}

async function main() {
  const [tmhReportPath, tmhLogPath, claudeReportPath, claudeLogPath] = process.argv.slice(2);
  if (!tmhReportPath || !tmhLogPath || !claudeReportPath || !claudeLogPath) {
    console.error("Usage: report.ts <tmhReportJson> <tmhLogJsonl> <claudeReportJson> <claudeLogJsonl>");
    process.exitCode = 1;
    return;
  }

  const [tmhReport, tmhLog, claudeReport, claudeLog] = await Promise.all([
    loadReport(tmhReportPath),
    loadLog(tmhLogPath),
    loadReport(claudeReportPath),
    loadLog(claudeLogPath),
  ]);

  const tmh = summarize("tmh harness", tmhReport, tmhLog, true);
  const claude = summarize("Claude Code", claudeReport, claudeLog, false);

  console.log("\nInstances resolved by tmh but not Claude Code:");
  const tmhOnly = [...tmh.resolvedSet].filter((id) => !claude.resolvedSet.has(id));
  console.log(tmhOnly.length ? tmhOnly.map((id) => `  ${id}`).join("\n") : "  (none)");

  console.log("\nInstances resolved by Claude Code but not tmh:");
  const claudeOnly = [...claude.resolvedSet].filter((id) => !tmh.resolvedSet.has(id));
  console.log(claudeOnly.length ? claudeOnly.map((id) => `  ${id}`).join("\n") : "  (none)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
