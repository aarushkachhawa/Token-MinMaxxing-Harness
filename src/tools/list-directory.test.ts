import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createListDirectoryTool } from "./list-directory.js";

let tempRoot: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "list-dir-test-"));
  workspace = join(tempRoot, "workspace");
  outside = join(tempRoot, "outside");
  await mkdir(workspace);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("createListDirectoryTool", () => {
  it("lists the workspace root by default when path is omitted", async () => {
    await writeFile(join(workspace, "a.txt"), "");
    await mkdir(join(workspace, "src"));
    const tool = createListDirectoryTool(workspace);

    const result = await tool.execute({});

    expect(result).toMatchObject({
      path: ".",
      entries: [
        { name: "a.txt", type: "file" },
        { name: "src", type: "directory" },
      ],
      truncated: false,
    });
  });

  it("lists a nested subdirectory", async () => {
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "b.txt"), "");
    const tool = createListDirectoryTool(workspace);

    const result = await tool.execute({ path: "src" });

    expect(result).toMatchObject({ entries: [{ name: "b.txt", type: "file" }] });
  });

  it("sorts entries alphabetically", async () => {
    await writeFile(join(workspace, "zebra.txt"), "");
    await writeFile(join(workspace, "apple.txt"), "");
    const tool = createListDirectoryTool(workspace);

    const result = (await tool.execute({ path: "." })) as { entries: { name: string }[] };

    expect(result.entries.map((e) => e.name)).toEqual(["apple.txt", "zebra.txt"]);
  });

  it("identifies a symlink entry by name without following it", async () => {
    await writeFile(join(outside, "secret.txt"), "top secret");
    await symlink(join(outside, "secret.txt"), join(workspace, "link.txt"));
    const tool = createListDirectoryTool(workspace);

    const result = (await tool.execute({ path: "." })) as { entries: { name: string; type: string }[] };

    expect(result.entries).toContainEqual({ name: "link.txt", type: "symlink" });
  });

  it("throws for a directory that doesn't exist", async () => {
    const tool = createListDirectoryTool(workspace);
    await expect(tool.execute({ path: "ghost" })).rejects.toThrow(/not found/);
  });

  it("throws when the path is a file, not a directory", async () => {
    await writeFile(join(workspace, "a.txt"), "");
    const tool = createListDirectoryTool(workspace);
    await expect(tool.execute({ path: "a.txt" })).rejects.toThrow(/not a directory/);
  });

  it("rejects a relative path that traverses outside the workspace", async () => {
    const tool = createListDirectoryTool(workspace);
    await expect(tool.execute({ path: "../outside" })).rejects.toThrow(/escapes the workspace/);
  });

  it("rejects an absolute path pointing outside the workspace", async () => {
    const tool = createListDirectoryTool(workspace);
    await expect(tool.execute({ path: outside })).rejects.toThrow(/escapes the workspace/);
  });

  it("rejects listing through a symlinked directory that points outside the workspace", async () => {
    await symlink(outside, join(workspace, "link-dir"), "dir");
    const tool = createListDirectoryTool(workspace);
    await expect(tool.execute({ path: "link-dir" })).rejects.toThrow(/escapes the workspace/);
  });

  it("truncates a directory with more entries than maxEntries and reports it", async () => {
    for (let i = 0; i < 10; i++) {
      await writeFile(join(workspace, `file-${i}.txt`), "");
    }
    const tool = createListDirectoryTool(workspace, { maxEntries: 3 });

    const result = (await tool.execute({ path: "." })) as {
      entries: unknown[];
      truncated: boolean;
      note?: string;
    };

    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(3);
    expect(result.note).toMatch(/truncated to 3 of 10 entries/);
  });

  it("rejects malformed args via the zod schema", async () => {
    const tool = createListDirectoryTool(workspace);
    await expect(tool.execute({ path: 123 })).rejects.toThrow();
  });
});
