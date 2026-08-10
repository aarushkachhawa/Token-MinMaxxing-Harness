import { describe, expect, it } from "vitest";
import { formatConversationHistory } from "./anthropic-orchestrator-client.js";
import type { ConversationTurn } from "./types.js";

function turn(overrides: Partial<ConversationTurn> & { requestDescription: string }): ConversationTurn {
  return { finalText: "an answer", ...overrides };
}

describe("formatConversationHistory", () => {
  it("returns an empty string for no history, so a single-shot prompt is unaffected", () => {
    expect(formatConversationHistory([])).toBe("");
  });

  it("includes the request and answer for a single turn", () => {
    const text = formatConversationHistory([
      turn({ requestDescription: "what does the Orchestrator do", finalText: "It decomposes requests." }),
    ]);
    expect(text).toContain("what does the Orchestrator do");
    expect(text).toContain("It decomposes requests.");
    expect(text).toContain("Turn 1");
  });

  it("preserves turn order across multiple turns", () => {
    const text = formatConversationHistory([
      turn({ requestDescription: "first request", finalText: "first answer" }),
      turn({ requestDescription: "second request", finalText: "second answer" }),
    ]);
    const firstIndex = text.indexOf("first request");
    const secondIndex = text.indexOf("second request");
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it("keeps only the most recent turns once history exceeds the cap", () => {
    const history = Array.from({ length: 8 }, (_, i) =>
      turn({ requestDescription: `request ${i}`, finalText: `answer ${i}` })
    );
    const text = formatConversationHistory(history);
    // Oldest turns (0, 1, 2) should have been dropped; only the most recent ones remain.
    expect(text).not.toContain("request 0");
    expect(text).not.toContain("request 1");
    expect(text).not.toContain("request 2");
    expect(text).toContain("request 7");
  });

  it("truncates a long answer instead of including it in full", () => {
    const longAnswer = "x".repeat(2000);
    const text = formatConversationHistory([turn({ requestDescription: "req", finalText: longAnswer })]);
    expect(text).not.toContain(longAnswer);
    expect(text).toContain("...");
    expect(text.length).toBeLessThan(longAnswer.length);
  });

  it("ends with a separator so it can be safely prefixed onto a prompt", () => {
    const text = formatConversationHistory([turn({ requestDescription: "req" })]);
    expect(text.endsWith("---\n\n")).toBe(true);
  });
});
