import { describe, expect, it } from "vitest";
import { formatSummarizationPrompt } from "./anthropic-conversation-summarizer.js";
import type { ConversationTurn } from "../orchestrator/types.js";

function turn(overrides: Partial<ConversationTurn> & { requestDescription: string }): ConversationTurn {
  return { finalText: "an answer", ...overrides };
}

describe("formatSummarizationPrompt", () => {
  it("includes the request and answer", () => {
    const prompt = formatSummarizationPrompt(
      turn({ requestDescription: "what does foo.ts export", finalText: "It exports bar()." })
    );
    expect(prompt).toContain("what does foo.ts export");
    expect(prompt).toContain("It exports bar().");
  });

  it("truncates a long answer instead of including it in full", () => {
    const longAnswer = "x".repeat(5000);
    const prompt = formatSummarizationPrompt(turn({ requestDescription: "req", finalText: longAnswer }));
    expect(prompt).not.toContain(longAnswer);
    expect(prompt).toContain("...");
    expect(prompt.length).toBeLessThan(longAnswer.length);
  });
});
