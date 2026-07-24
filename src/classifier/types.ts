export interface ClassificationRule {
  category: string;
  /** Case-insensitive substring matches against the task description. */
  keywords: string[];
}

export interface ClassifierRequest {
  taskDescription: string;
  candidateCategories: string[];
  /** Distinct categories the heuristics matched before falling back: empty if none matched, 2+ if conflicting. */
  matchedCategories: string[];
}

/** Reads the actual task and picks a category from candidateCategories. */
export interface ClassifierClient {
  classify(request: ClassifierRequest): Promise<string>;
}

export interface ClassificationResult {
  category: string;
  source: "heuristic" | "llm";
  matchedCategories: string[];
}
