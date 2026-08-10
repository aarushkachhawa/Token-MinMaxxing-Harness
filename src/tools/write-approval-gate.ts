import { createInterface } from "node:readline/promises";
import type { WriteInfo } from "./write-file.js";

/**
 * Pure formatting of the pending-write summary shown before the interactive approval prompt --
 * split out from the actual stdin-prompting in `interactiveWriteApprovalGate` so the
 * path/new-vs-overwrite/before-after presentation can be unit tested without faking a terminal,
 * matching the formatJudgePrompt/actual-API-call split in reward/anthropic-judge-client.ts.
 */
export function formatWriteApprovalPrompt(info: WriteInfo): string {
  const isNew = info.previousContents === null;
  const lines = [`write_file wants to ${isNew ? "CREATE" : "OVERWRITE"}: ${info.path}`];
  if (!isNew) {
    lines.push("--- before ---", info.previousContents as string);
  }
  lines.push("--- after ---", info.newContents);
  return lines.join("\n");
}

/**
 * Real interactive approval gate for write_file, meant to be passed as `onBeforeWrite` when the
 * tool is scoped to an actual project repository rather than a disposable scratch directory (see
 * write-file-check.ts for the scratch-dir case, which doesn't need one). Prints the pending
 * change via formatWriteApprovalPrompt, then blocks on stdin for an explicit y/yes -- anything
 * else, including empty input, is treated as a refusal. This is a safety gate, so it fails
 * closed rather than defaulting to allow. Opens and closes its own readline interface per call
 * rather than holding one open across the whole run, so a run that never writes never leaves a
 * stdin handle open and the process can exit cleanly either way.
 */
export async function interactiveWriteApprovalGate(info: WriteInfo): Promise<boolean> {
  console.log(`\n${formatWriteApprovalPrompt(info)}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Allow this write? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
