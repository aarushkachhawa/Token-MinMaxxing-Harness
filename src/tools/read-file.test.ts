import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadFileTool } from "./read-file.js";

let tempRoot: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "read-file-test-"));
  workspace = join(tempRoot, "workspace");
  outside = join(tempRoot, "outside");
  await mkdir(workspace);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("createReadFileTool", () => {
  it("reads a file's contents", async () => {
    await writeFile(join(workspace, "a.txt"), "hello world");
    const tool = createReadFileTool(workspace);

    const result = await tool.execute({ path: "a.txt" });

    expect(result).toMatchObject({ path: "a.txt", contents: "hello world", truncated: false });
  });

  it("reads a file in a legitimately nested subdirectory", async () => {
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "b.txt"), "nested");
    const tool = createReadFileTool(workspace);

    const result = await tool.execute({ path: "src/b.txt" });

    expect(result).toMatchObject({ contents: "nested" });
  });

  it("throws for a file that doesn't exist", async () => {
    const tool = createReadFileTool(workspace);
    await expect(tool.execute({ path: "ghost.txt" })).rejects.toThrow(/not found/);
  });

  it("throws when the path is a directory", async () => {
    await mkdir(join(workspace, "adir"));
    const tool = createReadFileTool(workspace);
    await expect(tool.execute({ path: "adir" })).rejects.toThrow(/directory/);
  });

  it("rejects a relative path that traverses outside the workspace", async () => {
    await writeFile(join(outside, "secret.txt"), "top secret");
    const tool = createReadFileTool(workspace);
    await expect(tool.execute({ path: "../outside/secret.txt" })).rejects.toThrow(
      /escapes the workspace/
    );
  });

  it("rejects an absolute path pointing outside the workspace", async () => {
    await writeFile(join(outside, "secret.txt"), "top secret");
    const tool = createReadFileTool(workspace);
    await expect(tool.execute({ path: join(outside, "secret.txt") })).rejects.toThrow(
      /escapes the workspace/
    );
  });

  it("rejects a symlink inside the workspace that points outside it", async () => {
    await writeFile(join(outside, "secret.txt"), "top secret");
    await symlink(join(outside, "secret.txt"), join(workspace, "link.txt"));
    const tool = createReadFileTool(workspace);
    await expect(tool.execute({ path: "link.txt" })).rejects.toThrow(/escapes the workspace/);
  });

  it("truncates a file larger than maxBytes and reports it", async () => {
    await writeFile(join(workspace, "big.txt"), "x".repeat(1000));
    const tool = createReadFileTool(workspace, { maxBytes: 100 });

    const result = (await tool.execute({ path: "big.txt" })) as {
      contents: string;
      truncated: boolean;
      note?: string;
    };

    expect(result.truncated).toBe(true);
    expect(result.contents).toHaveLength(100);
    expect(result.note).toMatch(/truncated to 100 of 1000 bytes/);
  });

  it("does not report truncation for a file under the limit", async () => {
    await writeFile(join(workspace, "small.txt"), "short");
    const tool = createReadFileTool(workspace, { maxBytes: 100 });

    const result = (await tool.execute({ path: "small.txt" })) as { truncated: boolean; note?: string };

    expect(result.truncated).toBe(false);
    expect(result.note).toBeUndefined();
  });

  it("rejects malformed args via the zod schema", async () => {
    const tool = createReadFileTool(workspace);
    await expect(tool.execute({ path: 123 })).rejects.toThrow();
  });
});
