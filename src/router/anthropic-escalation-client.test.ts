import { describe, expect, it } from "vitest";
import { formatEscalationPrompt } from "./anthropic-escalation-client.js";
import type { EscalationRequest } from "./escalation.js";

describe("formatEscalationPrompt", () => {
  it("includes the category, task, and every candidate's stats", () => {
    const request: EscalationRequest = {
      category: "small-edit",
      taskDescription: "fix the off-by-one bug",
      candidates: [
        { modelId: "fast-cheap", cost: 0.01, meanSuccessRate: 0.6, pulls: 3 },
        { modelId: "smart-expensive", cost: 0.3, meanSuccessRate: 0.95, pulls: 0.5 },
      ],
    };

    const prompt = formatEscalationPrompt(request);

    expect(prompt).toContain("Category: small-edit");
    expect(prompt).toContain("Task: fix the off-by-one bug");
    expect(prompt).toContain("- fast-cheap: cost=0.01, mean success rate=0.60, pulls=3.0");
    expect(prompt).toContain("- smart-expensive: cost=0.3, mean success rate=0.95, pulls=0.5");
  });

  it("handles a single candidate", () => {
    const request: EscalationRequest = {
      category: "exploration",
      taskDescription: "task",
      candidates: [{ modelId: "only-option", cost: 0.05, meanSuccessRate: 0.5, pulls: 0 }],
    };

    const prompt = formatEscalationPrompt(request);

    expect(prompt).toContain("- only-option: cost=0.05, mean success rate=0.50, pulls=0.0");
  });
});
