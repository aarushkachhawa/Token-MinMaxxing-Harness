import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunCommandTool } from "./run-command.js";

let tempRoot: string;
let workspace: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "run-command-test-"));
  workspace = join(tempRoot, "workspace");
  await mkdir(workspace);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("createRunCommandTool", () => {
  it("runs a command and returns its stdout with exit code 0", async () => {
    const tool = createRunCommandTool(workspace);
    const result = await tool.execute({ command: "echo hello" });
    expect(result).toMatchObject({ command: "echo hello", exitCode: 0, timedOut: false });
    expect((result as { output: string }).output).toContain("hello");
  });

  it("runs the command with cwd pinned to the workspace root", async () => {
    const tool = createRunCommandTool(workspace);
    const result = (await tool.execute({ command: "pwd" })) as { output: string };
    const realWorkspace = await realpath(workspace);
    expect(result.output.trim()).toBe(realWorkspace);
  });

  it("reports a non-zero exit code without throwing, so a failing test is real signal, not a tool error", async () => {
    const tool = createRunCommandTool(workspace);
    const result = await tool.execute({ command: "exit 7" });
    expect(result).toMatchObject({ exitCode: 7, timedOut: false });
  });

  it("captures stderr as well as stdout in the combined output", async () => {
    const tool = createRunCommandTool(workspace);
    const result = (await tool.execute({ command: "echo out; echo err 1>&2" })) as { output: string };
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
  });

  it("kills a command that exceeds the timeout and reports timedOut", async () => {
    const tool = createRunCommandTool(workspace, { timeoutMs: 200 });
    const result = await tool.execute({ command: "sleep 5" });
    expect(result).toMatchObject({ timedOut: true });
  }, 10_000);

  it("truncates output past maxOutputBytes", async () => {
    const tool = createRunCommandTool(workspace, { maxOutputBytes: 20 });
    const result = (await tool.execute({ command: "echo 0123456789012345678901234567890123456789" })) as {
      output: string;
    };
    expect(result.output).toContain("[output truncated]");
    expect(result.output.length).toBeLessThan(60);
  });

  it("rejects a denylisted command outright, before it ever runs", async () => {
    const tool = createRunCommandTool(workspace);
    await expect(tool.execute({ command: "sudo rm -rf /" })).rejects.toThrow(/not allowed/);
  });

  it("uses a fully custom denylist when provided, replacing the default", async () => {
    const tool = createRunCommandTool(workspace, { denylist: [/forbidden-word/] });
    // "sudo" is in the default denylist but not this custom one -- should now be allowed through
    // to the shell, where it'll just fail with "command not found" rather than being blocked.
    const result = await tool.execute({ command: "echo sudo-test" });
    expect(result).toMatchObject({ exitCode: 0 });
    await expect(tool.execute({ command: "echo forbidden-word" })).rejects.toThrow(/not allowed/);
  });

  it("calls onBeforeExecute with the pending command and blocks it when the hook rejects", async () => {
    const seen: string[] = [];
    const tool = createRunCommandTool(workspace, {
      onBeforeExecute: (info) => {
        seen.push(info.command);
        return false;
      },
    });

    await expect(tool.execute({ command: "echo should-not-run" })).rejects.toThrow(/was blocked/);
    expect(seen).toEqual(["echo should-not-run"]);
  });

  it("runs the command when onBeforeExecute approves it", async () => {
    const tool = createRunCommandTool(workspace, { onBeforeExecute: () => true });
    const result = await tool.execute({ command: "echo approved" });
    expect(result).toMatchObject({ exitCode: 0 });
  });
});
