import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditFileTool } from "./edit-file.js";

let tempRoot: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "edit-file-test-"));
  workspace = join(tempRoot, "workspace");
  outside = join(tempRoot, "outside");
  await mkdir(workspace);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("createEditFileTool", () => {
  it("replaces a uniquely-matching excerpt, leaving the rest of the file untouched", async () => {
    await writeFile(join(workspace, "a.txt"), "line one\nline two\nline three\n");
    const tool = createEditFileTool(workspace);

    const result = await tool.execute({ path: "a.txt", old_string: "line two", new_string: "LINE TWO" });

    expect(result).toEqual({ path: "a.txt", bytesWritten: Buffer.byteLength("line one\nLINE TWO\nline three\n") });
    expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("line one\nLINE TWO\nline three\n");
  });

  it("replaces a multi-line excerpt correctly", async () => {
    const original = "function foo() {\n  return 1;\n}\n";
    await writeFile(join(workspace, "a.js"), original);
    const tool = createEditFileTool(workspace);

    await tool.execute({
      path: "a.js",
      old_string: "function foo() {\n  return 1;\n}",
      new_string: "function foo() {\n  return 2;\n}",
    });

    expect(await readFile(join(workspace, "a.js"), "utf-8")).toBe("function foo() {\n  return 2;\n}\n");
  });

  it("a large file with a small targeted change never requires reproducing the untouched content", async () => {
    // This is the exact failure shape edit_file exists to prevent: write_file would require the
    // caller to faithfully reproduce every one of these lines to change just one.
    const lines = Array.from({ length: 2000 }, (_, i) => `const x${i} = ${i};`);
    await writeFile(join(workspace, "big.js"), lines.join("\n") + "\n");
    const tool = createEditFileTool(workspace);

    await tool.execute({ path: "big.js", old_string: "const x999 = 999;", new_string: "const x999 = 999999;" });

    const result = await readFile(join(workspace, "big.js"), "utf-8");
    expect(result).toContain("const x999 = 999999;");
    expect(result).toContain("const x0 = 0;"); // untouched lines survived
    expect(result).toContain("const x1999 = 1999;"); // untouched lines survived
  });

  it("throws when old_string does not appear in the file at all", async () => {
    await writeFile(join(workspace, "a.txt"), "hello world");
    const tool = createEditFileTool(workspace);
    await expect(
      tool.execute({ path: "a.txt", old_string: "not present", new_string: "x" })
    ).rejects.toThrow(/not found/);
    expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("hello world");
  });

  it("throws when old_string matches more than one location, rather than guessing", async () => {
    await writeFile(join(workspace, "a.txt"), "foo\nfoo\nbar\n");
    const tool = createEditFileTool(workspace);
    await expect(tool.execute({ path: "a.txt", old_string: "foo", new_string: "baz" })).rejects.toThrow(
      /2 locations/
    );
    expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("foo\nfoo\nbar\n");
  });

  it("throws when the target file doesn't exist", async () => {
    const tool = createEditFileTool(workspace);
    await expect(
      tool.execute({ path: "missing.txt", old_string: "x", new_string: "y" })
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects when old_string and new_string are identical", async () => {
    await writeFile(join(workspace, "a.txt"), "hello");
    const tool = createEditFileTool(workspace);
    await expect(
      tool.execute({ path: "a.txt", old_string: "hello", new_string: "hello" })
    ).rejects.toThrow(/identical/);
  });

  it("rejects an empty old_string", async () => {
    await writeFile(join(workspace, "a.txt"), "hello");
    const tool = createEditFileTool(workspace);
    await expect(tool.execute({ path: "a.txt", old_string: "", new_string: "x" })).rejects.toThrow(
      /must not be empty/
    );
  });

  it("rejects a relative path that traverses outside the workspace", async () => {
    await writeFile(join(outside, "evil.txt"), "secret");
    const tool = createEditFileTool(workspace);
    await expect(
      tool.execute({ path: "../outside/evil.txt", old_string: "secret", new_string: "x" })
    ).rejects.toThrow(/escapes the workspace/);
    expect(await readFile(join(outside, "evil.txt"), "utf-8")).toBe("secret");
  });

  it("rejects editing through a symlinked directory that points outside the workspace", async () => {
    await writeFile(join(outside, "evil.txt"), "secret");
    await symlink(outside, join(workspace, "link-dir"), "dir");
    const tool = createEditFileTool(workspace);
    await expect(
      tool.execute({ path: "link-dir/evil.txt", old_string: "secret", new_string: "x" })
    ).rejects.toThrow(/escapes the workspace/);
  });

  it.each([".git/config", ".env", "node_modules/pkg/index.js"])(
    "rejects the denylisted path %s",
    async (path) => {
      await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true }).catch(() => {});
      await mkdir(join(workspace, ".git"), { recursive: true }).catch(() => {});
      await writeFile(join(workspace, path), "secret");
      const tool = createEditFileTool(workspace);
      await expect(tool.execute({ path, old_string: "secret", new_string: "x" })).rejects.toThrow(
        /not allowed/
      );
    }
  );

  it("rejects a result that would exceed the size cap", async () => {
    await writeFile(join(workspace, "a.txt"), "small");
    const tool = createEditFileTool(workspace, { maxBytes: 10 });
    await expect(
      tool.execute({ path: "a.txt", old_string: "small", new_string: "x".repeat(20) })
    ).rejects.toThrow(/too large/);
  });

  it("blocks the edit when onBeforeWrite returns false, and nothing is written to disk", async () => {
    await writeFile(join(workspace, "a.txt"), "hello");
    const tool = createEditFileTool(workspace, { onBeforeWrite: () => false });
    await expect(
      tool.execute({ path: "a.txt", old_string: "hello", new_string: "goodbye" })
    ).rejects.toThrow(/blocked/);
    expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("hello");
  });

  it("proceeds when onBeforeWrite returns true, having seen the exact old/new excerpt", async () => {
    await writeFile(join(workspace, "a.txt"), "hello world");
    let seen: unknown;
    const tool = createEditFileTool(workspace, {
      onBeforeWrite: (info) => {
        seen = info;
        return true;
      },
    });

    await tool.execute({ path: "a.txt", old_string: "hello", new_string: "goodbye" });

    expect(seen).toEqual({ path: "a.txt", oldString: "hello", newString: "goodbye" });
    expect(await readFile(join(workspace, "a.txt"), "utf-8")).toBe("goodbye world");
  });

  it("rejects malformed args via the zod schema", async () => {
    const tool = createEditFileTool(workspace);
    await expect(tool.execute({ path: "a.txt", old_string: "x" })).rejects.toThrow();
  });
});
