import { describe, expect, it } from "vitest";
import { formatWriteApprovalPrompt } from "./write-approval-gate.js";
import type { WriteInfo } from "./write-file.js";

describe("formatWriteApprovalPrompt", () => {
  it("labels a new file as CREATE and omits a before section", () => {
    const info: WriteInfo = { path: "notes/new.txt", previousContents: null, newContents: "hello world" };

    const prompt = formatWriteApprovalPrompt(info);

    expect(prompt).toContain("CREATE: notes/new.txt");
    expect(prompt).not.toContain("--- before ---");
    expect(prompt).toContain("--- after ---");
    expect(prompt).toContain("hello world");
  });

  it("labels an existing file as OVERWRITE and includes both before and after content", () => {
    const info: WriteInfo = {
      path: "src/index.ts",
      previousContents: "old contents",
      newContents: "new contents",
    };

    const prompt = formatWriteApprovalPrompt(info);

    expect(prompt).toContain("OVERWRITE: src/index.ts");
    expect(prompt).toContain("--- before ---");
    expect(prompt).toContain("old contents");
    expect(prompt).toContain("--- after ---");
    expect(prompt).toContain("new contents");
  });

  it("includes the path even when contents are empty strings", () => {
    const info: WriteInfo = { path: "empty.txt", previousContents: "", newContents: "" };

    const prompt = formatWriteApprovalPrompt(info);

    expect(prompt).toContain("OVERWRITE: empty.txt");
  });
});
