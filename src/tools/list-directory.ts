import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "../executor/types.js";

export interface ListDirectoryToolOptions {
  /** Hard cap on entries returned; default 500. A larger directory is truncated, not rejected. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 500;

const argsSchema = z.object({
  path: z.string().optional().default("."),
});

type EntryKind = "file" | "directory" | "symlink" | "other";

function kindOf(entry: Dirent): EntryKind {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

/**
 * A real, read-only directory-listing tool scoped to `workspaceRoot`, using the same path
 * containment approach as read_file: resolve against the root, realpath both sides, then
 * check containment -- so `../`, an absolute path, or a symlinked directory pointing outside
 * the workspace are all rejected. Listing a symlink *entry* by name (without following it) is
 * fine either way, since no content is exposed -- only read_file needs to reject following one.
 */
export function createListDirectoryTool(
  workspaceRoot: string,
  options: ListDirectoryToolOptions = {}
): Tool {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  return {
    name: "list_directory",
    description:
      "List the entries of a directory within the project. `path` is relative to the project " +
      "root and defaults to the root itself if omitted. Paths that escape the project are rejected.",
    parameters: argsSchema,
    async execute(args): Promise<unknown> {
      const { path: rawPath } = argsSchema.parse(args);

      const resolvedRoot = await realpath(workspaceRoot);
      const candidate = resolve(resolvedRoot, rawPath);

      let realCandidate: string;
      try {
        realCandidate = await realpath(candidate);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Directory not found: "${rawPath}"`);
        }
        throw err;
      }

      const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
      if (realCandidate !== resolvedRoot && !realCandidate.startsWith(rootWithSep)) {
        throw new Error(`Path escapes the workspace: "${rawPath}"`);
      }

      const stats = await stat(realCandidate);
      if (!stats.isDirectory()) {
        throw new Error(`"${rawPath}" is a file, not a directory`);
      }

      const dirents = await readdir(realCandidate, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));

      const truncated = dirents.length > maxEntries;
      const entries = dirents
        .slice(0, maxEntries)
        .map((entry) => ({ name: entry.name, type: kindOf(entry) }));

      return {
        path: rawPath,
        entries,
        truncated,
        ...(truncated ? { note: `truncated to ${maxEntries} of ${dirents.length} entries` } : {}),
      };
    },
  };
}
