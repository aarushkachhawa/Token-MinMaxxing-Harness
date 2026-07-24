import type { ClassificationRule, ClassificationResult, ClassifierClient } from "./types.js";

export interface TaskClassifierOptions {
  rules: ClassificationRule[];
  /** Consulted only when the heuristics don't produce exactly one matching category. */
  llmClient?: ClassifierClient;
}

/** Cheap keyword heuristics first; LLM fallback only when the rules are ambiguous or silent. */
export class TaskClassifier {
  private rules: ClassificationRule[];
  private categories: string[];
  private llmClient?: ClassifierClient;

  constructor(options: TaskClassifierOptions) {
    if (options.rules.length === 0) {
      throw new Error("TaskClassifier needs at least one rule");
    }
    this.rules = options.rules;
    this.categories = [...new Set(options.rules.map((rule) => rule.category))];
    this.llmClient = options.llmClient;
  }

  async classify(taskDescription: string): Promise<ClassificationResult> {
    const matched = [...this.matchHeuristics(taskDescription)];

    if (matched.length === 1) {
      return { category: matched[0], source: "heuristic", matchedCategories: matched };
    }

    if (!this.llmClient) {
      const reason =
        matched.length === 0
          ? `no heuristic rule matched "${taskDescription}"`
          : `ambiguous heuristic match (${matched.join(", ")}) for "${taskDescription}"`;
      throw new Error(`${reason} and no LLM fallback is configured`);
    }

    const category = await this.llmClient.classify({
      taskDescription,
      candidateCategories: this.categories,
      matchedCategories: matched,
    });
    if (!this.categories.includes(category)) {
      throw new Error(`Classifier LLM chose an unknown category "${category}"`);
    }
    return { category, source: "llm", matchedCategories: matched };
  }

  private matchHeuristics(taskDescription: string): Set<string> {
    const lower = taskDescription.toLowerCase();
    const matched = new Set<string>();
    for (const rule of this.rules) {
      if (rule.keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
        matched.add(rule.category);
      }
    }
    return matched;
  }
}
