import { createInterface } from "node:readline/promises";
import type { CommandInfo } from "./run-command.js";

/**
 * Pure formatting of the pending-command summary shown before the interactive approval prompt --
 * split out from the actual stdin-prompting in `interactiveRunCommandApprovalGate`, matching the
 * formatWriteApprovalPrompt/actual-approval split in write-approval-gate.ts.
 */
export function formatRunCommandApprovalPrompt(info: CommandInfo): string {
  return `run_command wants to run: ${info.command}`;
}

/**
 * Real interactive approval gate for run_command, meant to be passed as `onBeforeExecute` when
 * the tool is scoped to an actual project repository rather than a disposable/autonomous context
 * (a benchmark run has no human to ask, so run-instance.ts omits this entirely, same as it omits
 * write_file's onBeforeWrite). Prints the pending command, then blocks on stdin for an explicit
 * y/yes -- anything else, including empty input, is treated as a refusal. Fails closed, same as
 * interactiveWriteApprovalGate, and for the same reason: opens and closes its own readline
 * interface per call rather than holding one open across the whole run.
 */
export async function interactiveRunCommandApprovalGate(info: CommandInfo): Promise<boolean> {
  console.log(`\n${formatRunCommandApprovalPrompt(info)}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Allow this command? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
