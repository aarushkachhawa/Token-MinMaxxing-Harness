import { describe, expect, it } from "vitest";
import { formatClassifierPrompt } from "./anthropic-classifier-client.js";
import type { ClassifierRequest } from "./types.js";

describe("formatClassifierPrompt", () => {
  it("notes when the heuristics found no match at all", () => {
    const request: ClassifierRequest = {
      taskDescription: "write a poem about autumn",
      candidateCategories: ["small-edit", "exploration"],
      matchedCategories: [],
    };

    const prompt = formatClassifierPrompt(request);

    expect(prompt).toContain("write a poem about autumn");
    expect(prompt).toContain("The heuristics found no match at all.");
    expect(prompt).toContain("Candidate categories: small-edit, exploration");
  });

  it("notes which categories ambiguously matched", () => {
    const request: ClassifierRequest = {
      taskDescription: "refactor this to fix the bug",
      candidateCategories: ["small-edit", "multi-file-refactor"],
      matchedCategories: ["small-edit", "multi-file-refactor"],
    };

    const prompt = formatClassifierPrompt(request);

    expect(prompt).toContain("The heuristics ambiguously matched: small-edit, multi-file-refactor.");
  });
});
