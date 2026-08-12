import { describe, expect, it } from "vitest";
import { formatEditApprovalPrompt } from "./edit-approval-gate.js";
import type { EditInfo } from "./edit-file.js";

describe("formatEditApprovalPrompt", () => {
  it("includes the path and both the old and new excerpts", () => {
    const info: EditInfo = { path: "src/index.ts", oldString: "const x = 1;", newString: "const x = 2;" };

    const prompt = formatEditApprovalPrompt(info);

    expect(prompt).toContain("edit_file wants to change: src/index.ts");
    expect(prompt).toContain("--- old ---");
    expect(prompt).toContain("const x = 1;");
    expect(prompt).toContain("--- new ---");
    expect(prompt).toContain("const x = 2;");
  });
});
