import { readFile, realpath, stat, writeFile as fsWriteFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "../executor/types.js";

export interface WriteInfo {
  /** The raw relative path as given by the caller. */
  path: string;
  /** null if the file did not already exist (this write creates it). */
  previousContents: string | null;
  newContents: string;
}

export interface WriteFileToolOptions {
  /** Hard cap on bytes written; default ~100KB. Rejected outright, not truncated -- truncating
   * a write would silently corrupt the intended content, worse than truncating a read. */
  maxBytes?: number;
  /** Relative-path patterns that are always rejected, regardless of workspace containment.
   * Defaults to .git/, .env*, and node_modules/ -- being inside the workspace isn't the same
   * as being safe to write to. Replaces the default list entirely rather than adding to it. */
  denylist?: RegExp[];
  /** Called with the pending change before it's written. Returning false (or a rejected
   * promise) aborts the write. Omit to write autonomously, same as every other tool here. */
  onBeforeWrite?: (info: WriteInfo) => boolean | Promise<boolean>;
}

const DEFAULT_MAX_BYTES = 100_000;
const DEFAULT_DENYLIST: RegExp[] = [/(^|\/)\.git(\/|$)/, /(^|\/)\.env(\..*)?$/, /(^|\/)node_modules(\/|$)/];

const argsSchema = z.object({
  path: z.string(),
  contents: z.string(),
});

/**
 * A real, sandboxed write tool scoped to `workspaceRoot`. Same containment approach as
 * read_file/list_directory (resolve, realpath both sides, check containment) applied to the
 * parent directory rather than the file itself, since the target file may not exist yet. On
 * top of containment: a denylist for project-internal sensitive paths, no auto-created parent
 * directories, a size cap that rejects rather than truncates, and an optional approval hook
 * that sees the actual before/after content before the write commits.
 */
export function createWriteFileTool(workspaceRoot: string, options: WriteFileToolOptions = {}): Tool {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const denylist = options.denylist ?? DEFAULT_DENYLIST;

  return {
    name: "write_file",
    description:
      "Create or overwrite a text file within the project. `path` is relative to the project " +
      "root; paths that escape the project, or that target .git/.env/node_modules, are " +
      "rejected. The parent directory must already exist.",
    parameters: argsSchema,
    async execute(args): Promise<unknown> {
      const { path: rawPath, contents } = argsSchema.parse(args);

      if (Buffer.byteLength(contents, "utf-8") > maxBytes) {
        throw new Error(`Content too large: exceeds ${maxBytes} byte limit`);
      }

      const resolvedRoot = await realpath(workspaceRoot);
      const candidate = resolve(resolvedRoot, rawPath);
      const parentDir = dirname(candidate);

      let realParentDir: string;
      try {
        realParentDir = await realpath(parentDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Parent directory does not exist: "${dirname(rawPath)}"`);
        }
        throw err;
      }

      const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
      if (realParentDir !== resolvedRoot && !realParentDir.startsWith(rootWithSep)) {
        throw new Error(`Path escapes the workspace: "${rawPath}"`);
      }

      const realPath = join(realParentDir, basename(candidate));
      const relativePath = relative(resolvedRoot, realPath).split(sep).join("/");

      if (denylist.some((pattern) => pattern.test(relativePath))) {
        throw new Error(`Path is not allowed: "${rawPath}"`);
      }

      let previousContents: string | null = null;
      let existingStat;
      try {
        existingStat = await stat(realPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (existingStat) {
        if (existingStat.isDirectory()) {
          throw new Error(`"${rawPath}" is a directory, not a file`);
        }
        previousContents = await readFile(realPath, "utf-8");
      }

      const writeInfo: WriteInfo = { path: rawPath, previousContents, newContents: contents };
      if (options.onBeforeWrite && !(await options.onBeforeWrite(writeInfo))) {
        throw new Error(`Write to "${rawPath}" was blocked`);
      }

      await fsWriteFile(realPath, contents, "utf-8");

      return {
        path: rawPath,
        created: previousContents === null,
        previousContents,
        newContents: contents,
        bytesWritten: Buffer.byteLength(contents, "utf-8"),
      };
    },
  };
}
