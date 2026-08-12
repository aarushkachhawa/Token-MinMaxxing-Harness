import { describe, expect, it } from "vitest";
import { formatRunCommandApprovalPrompt } from "./run-command-approval-gate.js";
import type { CommandInfo } from "./run-command.js";

describe("formatRunCommandApprovalPrompt", () => {
  it("includes the exact pending command", () => {
    const info: CommandInfo = { command: "python -m pytest tests/test_foo.py -x" };

    const prompt = formatRunCommandApprovalPrompt(info);

    expect(prompt).toContain("run_command wants to run:");
    expect(prompt).toContain("python -m pytest tests/test_foo.py -x");
  });
});
