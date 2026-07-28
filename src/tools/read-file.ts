import { open, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "../executor/types.js";

export interface ReadFileToolOptions {
  /** Hard cap on bytes returned; default ~100KB. Larger files are truncated, not rejected. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 100_000;

const argsSchema = z.object({
  path: z.string(),
});

/**
 * A real, read-only file tool scoped to `workspaceRoot`. Every path is resolved against the
 * root and symlink-resolved (fs.realpath) on both sides before a containment check, so neither
 * `../` traversal nor an absolute path nor a symlink pointing outside the workspace can escape
 * it — `path.resolve(root, path)` happily honors an absolute `path` by overriding the root
 * entirely, but the containment check below rejects the result regardless of how it got there.
 */
export function createReadFileTool(workspaceRoot: string, options: ReadFileToolOptions = {}): Tool {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    name: "read_file",
    description:
      "Read the contents of a text file within the project. `path` is relative to the project " +
      "root; paths that escape the project are rejected. Large files are truncated, not rejected.",
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
          throw new Error(`File not found: "${rawPath}"`);
        }
        throw err;
      }

      const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
      if (realCandidate !== resolvedRoot && !realCandidate.startsWith(rootWithSep)) {
        throw new Error(`Path escapes the workspace: "${rawPath}"`);
      }

      const stats = await stat(realCandidate);
      if (stats.isDirectory()) {
        throw new Error(`"${rawPath}" is a directory, not a file`);
      }

      const truncated = stats.size > maxBytes;
      const readLength = Math.min(stats.size, maxBytes);
      const buffer = Buffer.alloc(readLength);
      const handle = await open(realCandidate, "r");
      try {
        await handle.read(buffer, 0, readLength, 0);
      } finally {
        await handle.close();
      }

      return {
        path: rawPath,
        contents: buffer.toString("utf-8"),
        truncated,
        ...(truncated ? { note: `truncated to ${maxBytes} of ${stats.size} bytes` } : {}),
      };
    },
  };
}
