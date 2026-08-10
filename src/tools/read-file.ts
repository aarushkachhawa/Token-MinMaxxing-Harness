import { open, readFile, realpath, stat } from "node:fs/promises";
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
  /** 1-indexed line number to start reading from. Defaults to 1 (start of file), which combined
   * with no `limit` reproduces the original whole-file-up-to-maxBytes behavior exactly. */
  offset: z.number().int().min(1).optional().default(1),
  /** Max number of lines to return, starting at `offset`. Defaults to no limit (read through the
   * rest of the file, subject to maxBytes). */
  limit: z.number().int().min(1).optional(),
});

/**
 * A real, read-only file tool scoped to `workspaceRoot`. Every path is resolved against the
 * root and symlink-resolved (fs.realpath) on both sides before a containment check, so neither
 * `../` traversal nor an absolute path nor a symlink pointing outside the workspace can escape
 * it — `path.resolve(root, path)` happily honors an absolute `path` by overriding the root
 * entirely, but the containment check below rejects the result regardless of how it got there.
 *
 * `offset`/`limit` let a caller ask for a specific line range instead of the head of the file.
 * `offset` past the end of the file is a legitimate no-op (empty content, no error) rather than
 * a rejection -- unlike the security-motivated rejections above, there's nothing unsafe about it.
 * `maxBytes` still applies as a safety net on top of any requested range, since a huge `limit`
 * (or no limit) against a huge file could otherwise return an unbounded amount of content.
 */
export function createReadFileTool(workspaceRoot: string, options: ReadFileToolOptions = {}): Tool {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    name: "read_file",
    description:
      "Read the contents of a text file within the project. `path` is relative to the project " +
      "root; paths that escape the project are rejected. Large files are truncated, not rejected. " +
      "Optional `offset` (1-indexed line number to start at, default 1) and `limit` (max lines to " +
      "return, default: rest of file) select a specific line range instead of reading from the " +
      "start; an `offset` past the end of the file returns empty content rather than an error. " +
      "The `maxBytes` cap still applies to whatever range is selected.",
    parameters: argsSchema,
    async execute(args): Promise<unknown> {
      const { path: rawPath, offset, limit } = argsSchema.parse(args);

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

      // Default case (offset=1, no limit): identical to pre-offset/limit behavior, byte for byte.
      if (offset === 1 && limit === undefined) {
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
      }

      // Line-range read: split into lines (keeping line terminators attached so rejoining is
      // byte-exact), slice out the requested range, then apply maxBytes as a safety net.
      const fullText = (await readFile(realCandidate)).toString("utf-8");
      const lines = fullText.length === 0 ? [] : fullText.split(/(?<=\n)/);

      const startIndex = offset - 1;
      const selectedLines =
        startIndex >= lines.length
          ? []
          : lines.slice(startIndex, limit !== undefined ? startIndex + limit : undefined);

      let contents = selectedLines.join("");
      const selectedBytes = Buffer.byteLength(contents, "utf-8");
      const truncated = selectedBytes > maxBytes;
      if (truncated) {
        contents = Buffer.from(contents, "utf-8").subarray(0, maxBytes).toString("utf-8");
      }

      return {
        path: rawPath,
        contents,
        truncated,
        ...(truncated ? { note: `truncated to ${maxBytes} of ${selectedBytes} bytes` } : {}),
        offset,
        ...(limit !== undefined ? { limit } : {}),
        linesReturned: selectedLines.length,
      };
    },
  };
}
