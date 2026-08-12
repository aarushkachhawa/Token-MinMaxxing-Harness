import { createInterface } from "node:readline/promises";
import type { EditInfo } from "./edit-file.js";

/**
 * Pure formatting of the pending-edit summary shown before the interactive approval prompt --
 * shows just the changed excerpt (old_string -> new_string), not a full before/after file dump,
 * since a large-file/small-change edit is exactly what this tool exists to make reviewable
 * without drowning the actual change in unrelated unchanged lines. Split out from the actual
 * stdin-prompting, matching formatWriteApprovalPrompt/interactiveWriteApprovalGate's split.
 */
export function formatEditApprovalPrompt(info: EditInfo): string {
  return [
    `edit_file wants to change: ${info.path}`,
    "--- old ---",
    info.oldString,
    "--- new ---",
    info.newString,
  ].join("\n");
}

/**
 * Real interactive approval gate for edit_file, meant to be passed as `onBeforeWrite` when the
 * tool is scoped to an actual project repository -- same shape and same fail-closed behavior as
 * interactiveWriteApprovalGate: opens and closes its own readline interface per call, treats
 * anything other than an explicit y/yes as a refusal.
 */
export async function interactiveEditApprovalGate(info: EditInfo): Promise<boolean> {
  console.log(`\n${formatEditApprovalPrompt(info)}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Allow this edit? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
