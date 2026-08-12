import { readFile, realpath, writeFile as fsWriteFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "../executor/types.js";

export interface EditInfo {
  /** The raw relative path as given by the caller. */
  path: string;
  oldString: string;
  newString: string;
}

export interface EditFileToolOptions {
  /** Hard cap on the resulting file's byte size; matches write_file's default. */
  maxBytes?: number;
  /** Same spirit as write_file's denylist -- default .git/, .env*, node_modules/. Replaces the default list entirely. */
  denylist?: RegExp[];
  /** Called with the pending change before it's written. Returning false (or a rejected promise) aborts the edit. */
  onBeforeWrite?: (info: EditInfo) => boolean | Promise<boolean>;
}

const DEFAULT_MAX_BYTES = 100_000;
const DEFAULT_DENYLIST: RegExp[] = [/(^|\/)\.git(\/|$)/, /(^|\/)\.env(\..*)?$/, /(^|\/)node_modules(\/|$)/];

const argsSchema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
});

/**
 * A targeted search-replace edit tool, scoped to `workspaceRoot` like write_file. Exists because
 * write_file requires the *entire* file's content on every call -- a small requested change to a
 * large file means the model has to faithfully reproduce every other line untouched, and a
 * silent reproduction failure (a weak/cheap model truncating instead of copying) turns into
 * wholesale, undetected data loss: it collapsed a 2,328-line file to 3 in one observed case. This
 * tool removes that failure mode structurally by only ever asking for the change itself.
 *
 * Uses plain search-replace (old_string/new_string), not a unified-diff apply: matches Claude
 * Code's own Edit tool, and a diff format's line numbers/hunk headers/context lines are exactly
 * the kind of thing a weaker model gets subtly wrong -- a plain "here's the exact text, here's
 * what it becomes" is far more reliable to produce correctly. `old_string` must appear in the
 * file exactly once; zero or multiple matches are rejected rather than guessed at (a wrong guess
 * here is silent corruption, same failure shape this tool exists to prevent), so the caller
 * either re-reads the file for an exact match or adds more surrounding context to disambiguate.
 */
export function createEditFileTool(workspaceRoot: string, options: EditFileToolOptions = {}): Tool {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const denylist = options.denylist ?? DEFAULT_DENYLIST;

  return {
    name: "edit_file",
    description:
      "Make a targeted change to an existing text file within the project, without rewriting " +
      "the whole file. `path` is relative to the project root. `old_string` must be an exact, " +
      "unique excerpt of the file's current content (include enough surrounding context to make " +
      "it unique if the text appears more than once) -- it's replaced with `new_string`. Use " +
      "write_file instead to create a new file or replace one entirely.",
    parameters: argsSchema,
    async execute(args): Promise<unknown> {
      const { path: rawPath, old_string: oldString, new_string: newString } = argsSchema.parse(args);

      if (oldString === newString) {
        throw new Error("old_string and new_string are identical -- there's no change to make");
      }
      if (oldString.length === 0) {
        throw new Error("old_string must not be empty -- use write_file to create a new file");
      }

      const resolvedRoot = await realpath(workspaceRoot);
      const candidate = resolve(resolvedRoot, rawPath);
      const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;

      let realPath: string;
      try {
        realPath = await realpath(candidate);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`File does not exist: "${rawPath}" -- use write_file to create it`);
        }
        throw err;
      }

      if (realPath !== resolvedRoot && !realPath.startsWith(rootWithSep)) {
        throw new Error(`Path escapes the workspace: "${rawPath}"`);
      }

      const relativePath = relative(resolvedRoot, realPath).split(sep).join("/");
      if (denylist.some((pattern) => pattern.test(relativePath))) {
        throw new Error(`Path is not allowed: "${rawPath}"`);
      }

      const currentContents = await readFile(realPath, "utf-8");
      const occurrences = countOccurrences(currentContents, oldString);
      if (occurrences === 0) {
        throw new Error(
          `old_string not found in "${rawPath}" -- re-read the file and provide an exact excerpt of its current content`
        );
      }
      if (occurrences > 1) {
        throw new Error(
          `old_string matches ${occurrences} locations in "${rawPath}" -- include more surrounding context so it identifies exactly one`
        );
      }

      const newContents = currentContents.replace(oldString, newString);

      if (Buffer.byteLength(newContents, "utf-8") > maxBytes) {
        throw new Error(`Resulting content too large: exceeds ${maxBytes} byte limit`);
      }

      const editInfo: EditInfo = { path: rawPath, oldString, newString };
      if (options.onBeforeWrite && !(await options.onBeforeWrite(editInfo))) {
        throw new Error(`Edit to "${rawPath}" was blocked`);
      }

      await fsWriteFile(realPath, newContents, "utf-8");

      return {
        path: rawPath,
        bytesWritten: Buffer.byteLength(newContents, "utf-8"),
      };
    },
  };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count++;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}
