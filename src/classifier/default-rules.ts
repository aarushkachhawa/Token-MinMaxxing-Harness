import type { ClassificationRule } from "./types.js";

export const DEFAULT_CLASSIFICATION_RULES: ClassificationRule[] = [
  {
    category: "trivial-lookup",
    keywords: ["what is", "where is", "look up", "find the", "show me"],
  },
  {
    category: "small-edit",
    keywords: ["fix", "bug", "typo", "rename", "small change"],
  },
  {
    category: "multi-file-refactor",
    keywords: ["refactor", "across files", "reorganize", "restructure", "split into"],
  },
  {
    category: "test-authoring",
    keywords: ["write test", "add test", "unit test", "test coverage"],
  },
  {
    category: "exploration",
    keywords: ["understand", "investigate", "explore", "figure out", "how does"],
  },
];
