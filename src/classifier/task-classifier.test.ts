import { describe, expect, it } from "vitest";
import { DEFAULT_CLASSIFICATION_RULES } from "./default-rules.js";
import { ScriptedClassifierClient } from "./fakes.js";
import { TaskClassifier } from "./task-classifier.js";
import type { ClassificationRule } from "./types.js";

const rules: ClassificationRule[] = [
  { category: "small-edit", keywords: ["fix", "bug", "typo"] },
  { category: "multi-file-refactor", keywords: ["refactor", "reorganize"] },
  { category: "exploration", keywords: ["understand", "investigate"] },
];

describe("TaskClassifier", () => {
  it("throws if constructed with no rules", () => {
    expect(() => new TaskClassifier({ rules: [] })).toThrow();
  });

  it("returns the single matching category via heuristics, case-insensitively", async () => {
    const classifier = new TaskClassifier({ rules });

    const result = await classifier.classify("please FIX the off-by-one bug");

    expect(result).toEqual({
      category: "small-edit",
      source: "heuristic",
      matchedCategories: ["small-edit"],
    });
  });

  it("throws on no heuristic match when no LLM fallback is configured", async () => {
    const classifier = new TaskClassifier({ rules });
    await expect(classifier.classify("write a poem about autumn")).rejects.toThrow(
      /no heuristic rule matched/
    );
  });

  it("throws on an ambiguous heuristic match when no LLM fallback is configured", async () => {
    const classifier = new TaskClassifier({ rules });
    await expect(classifier.classify("refactor this to fix the bug")).rejects.toThrow(
      /ambiguous heuristic match/
    );
  });

  it("falls back to the LLM client when nothing matched, passing an empty matchedCategories", async () => {
    const llm = new ScriptedClassifierClient(["exploration"]);
    const classifier = new TaskClassifier({ rules, llmClient: llm });

    const result = await classifier.classify("write a poem about autumn");

    expect(result).toEqual({ category: "exploration", source: "llm", matchedCategories: [] });
    expect(llm.receivedRequests).toHaveLength(1);
    expect(llm.receivedRequests[0].matchedCategories).toEqual([]);
    expect(llm.receivedRequests[0].candidateCategories.sort()).toEqual(
      ["exploration", "multi-file-refactor", "small-edit"].sort()
    );
  });

  it("falls back to the LLM client on an ambiguous match, passing the conflicting categories", async () => {
    const llm = new ScriptedClassifierClient(["small-edit"]);
    const classifier = new TaskClassifier({ rules, llmClient: llm });

    const result = await classifier.classify("refactor this to fix the bug");

    expect(result.source).toBe("llm");
    expect(result.category).toBe("small-edit");
    expect(llm.receivedRequests[0].matchedCategories.sort()).toEqual(
      ["multi-file-refactor", "small-edit"].sort()
    );
  });

  it("rejects an LLM choice that isn't one of the known categories", async () => {
    const llm = new ScriptedClassifierClient(["made-up-category"]);
    const classifier = new TaskClassifier({ rules, llmClient: llm });

    await expect(classifier.classify("write a poem about autumn")).rejects.toThrow(
      /unknown category/
    );
  });

  it("ships default rules covering the categories named in the architecture doc", async () => {
    const classifier = new TaskClassifier({ rules: DEFAULT_CLASSIFICATION_RULES });

    expect((await classifier.classify("fix the typo in the header")).category).toBe("small-edit");
    expect((await classifier.classify("refactor this across files")).category).toBe(
      "multi-file-refactor"
    );
    expect((await classifier.classify("write a unit test for this")).category).toBe(
      "test-authoring"
    );
    expect((await classifier.classify("help me understand this module")).category).toBe(
      "exploration"
    );
    expect((await classifier.classify("where is the config file")).category).toBe(
      "trivial-lookup"
    );
  });
});
