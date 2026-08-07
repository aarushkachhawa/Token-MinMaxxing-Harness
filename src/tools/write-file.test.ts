import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWriteFileTool } from "./write-file.js";

let tempRoot: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "write-file-test-"));
  workspace = join(tempRoot, "workspace");
  outside = join(tempRoot, "outside");
  await mkdir(workspace);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("createWriteFileTool", () => {
  it("creates a new file that didn't exist", async () => {
    const tool = createWriteFileTool(workspace);

    const result = await tool.execute({ path: "a.txt", contents: "hello" });

    expect(result).toEqual({
      path: "a.txt",
      created: true,
      previousContents: null,
      newContents: "hello",
      bytesWritten: 5,
    });
    expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("hello");
  });

  it("overwrites an existing file and reports the previous contents", async () => {
    await writeFile(join(workspace, "a.txt"), "old");
    const tool = createWriteFileTool(workspace);

    const result = await tool.execute({ path: "a.txt", contents: "new" });

    expect(result).toMatchObject({ created: false, previousContents: "old", newContents: "new" });
    expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("new");
  });

  it("writes into a legitimately nested existing subdirectory", async () => {
    await mkdir(join(workspace, "src"));
    const tool = createWriteFileTool(workspace);

    await tool.execute({ path: "src/b.txt", contents: "nested" });

    expect(await readFile(join(workspace, "src", "b.txt"), "utf-8")).toBe("nested");
  });

  it("throws when the parent directory doesn't exist", async () => {
    const tool = createWriteFileTool(workspace);
    await expect(tool.execute({ path: "missing-dir/a.txt", contents: "x" })).rejects.toThrow(
      /Parent directory does not exist/
    );
  });

  it("throws when the target path is an existing directory", async () => {
    await mkdir(join(workspace, "adir"));
    const tool = createWriteFileTool(workspace);
    await expect(tool.execute({ path: "adir", contents: "x" })).rejects.toThrow(/directory/);
  });

  it("rejects a relative path that traverses outside the workspace", async () => {
    const tool = createWriteFileTool(workspace);
    await expect(tool.execute({ path: "../outside/evil.txt", contents: "x" })).rejects.toThrow(
      /escapes the workspace/
    );
    await expect(readFile(join(outside, "evil.txt"), "utf-8")).rejects.toThrow();
  });

  it("rejects an absolute path pointing outside the workspace", async () => {
    const tool = createWriteFileTool(workspace);
    await expect(
      tool.execute({ path: join(outside, "evil.txt"), contents: "x" })
    ).rejects.toThrow(/escapes the workspace/);
  });

  it("rejects writing through a symlinked directory that points outside the workspace", async () => {
    await symlink(outside, join(workspace, "link-dir"), "dir");
    const tool = createWriteFileTool(workspace);
    await expect(tool.execute({ path: "link-dir/evil.txt", contents: "x" })).rejects.toThrow(
      /escapes the workspace/
    );
  });

  it.each([".git/config", ".env", ".env.local", "node_modules/pkg/index.js", "src/.env"])(
    "rejects the denylisted path %s",
    async (path) => {
      const tool = createWriteFileTool(workspace);
      await mkdir(join(workspace, "src"), { recursive: true }).catch(() => {});
      await mkdir(join(workspace, ".git"), { recursive: true }).catch(() => {});
      await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true }).catch(() => {});
      await expect(tool.execute({ path, contents: "x" })).rejects.toThrow(/not allowed/);
    }
  );

  it("allows a custom denylist to be supplied instead of the default", async () => {
    const tool = createWriteFileTool(workspace, { denylist: [/secrets\.txt$/] });
    await expect(tool.execute({ path: "secrets.txt", contents: "x" })).rejects.toThrow(/not allowed/);
    // .env is NOT in this custom denylist, so it should be allowed
    await tool.execute({ path: ".env", contents: "x" });
    expect(await readFile(join(workspace, ".env"), "utf-8")).toBe("x");
  });

  it("rejects content over the size cap", async () => {
    const tool = createWriteFileTool(workspace, { maxBytes: 10 });
    await expect(tool.execute({ path: "big.txt", contents: "x".repeat(20) })).rejects.toThrow(
      /too large/
    );
  });

  it("blocks the write when onBeforeWrite returns false, and nothing is written to disk", async () => {
    const tool = createWriteFileTool(workspace, { onBeforeWrite: () => false });
    await expect(tool.execute({ path: "a.txt", contents: "x" })).rejects.toThrow(/blocked/);
    await expect(readFile(join(workspace, "a.txt"), "utf-8")).rejects.toThrow();
  });

  it("proceeds when onBeforeWrite returns true, having seen the real before/after content", async () => {
    await writeFile(join(workspace, "a.txt"), "old");
    let seen: unknown;
    const tool = createWriteFileTool(workspace, {
      onBeforeWrite: (info) => {
        seen = info;
        return true;
      },
    });

    await tool.execute({ path: "a.txt", contents: "new" });

    expect(seen).toEqual({ path: "a.txt", previousContents: "old", newContents: "new" });
    expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("new");
  });

  it("supports an async onBeforeWrite hook", async () => {
    const tool = createWriteFileTool(workspace, {
      onBeforeWrite: async () => {
        await Promise.resolve();
        return false;
      },
    });
    await expect(tool.execute({ path: "a.txt", contents: "x" })).rejects.toThrow(/blocked/);
  });

  it("rejects malformed args via the zod schema", async () => {
    const tool = createWriteFileTool(workspace);
    await expect(tool.execute({ path: "a.txt", contents: 123 })).rejects.toThrow();
  });
});
