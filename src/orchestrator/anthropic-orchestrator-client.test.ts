import { describe, expect, it } from "vitest";
import { findTurnsNeedingSummary, formatConversationHistory } from "./anthropic-orchestrator-client.js";
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

  // `#N#`-delimited markers, not plain "request N": with plain numeric suffixes, "request 1" is
  // a *substring* of "request 10"/"request 11"/etc, so a not.toContain("request 1") check would
  // false-negative as soon as double-digit indices are also present in the same text. Wrapping
  // the index in delimiters means "request #1#" can never be a substring of "request #10#".
  function marker(label: string, i: number): string {
    return `${label} #${i}#`;
  }

  it("keeps the most recent turns in full once history exceeds the recent-window cap", () => {
    const history = Array.from({ length: 8 }, (_, i) =>
      turn({ requestDescription: marker("request", i), finalText: marker("answer", i) })
    );
    const text = formatConversationHistory(history);
    // Recent window is the last 5 (indices 3-7): full request + answer, in order.
    for (const i of [3, 4, 5, 6, 7]) {
      expect(text).toContain(marker("request", i));
      expect(text).toContain(marker("answer", i));
    }
  });

  it("condenses turns older than the recent window to a request-only mention, no answer text", () => {
    const history = Array.from({ length: 8 }, (_, i) =>
      turn({ requestDescription: marker("request", i), finalText: marker("answer", i) })
    );
    const text = formatConversationHistory(history);
    // Turns 0-2 fall outside the 5-turn recent window but within the 10-turn condensed window --
    // their request text should still appear, but their answer text should not.
    for (const i of [0, 1, 2]) {
      expect(text).toContain(marker("request", i));
      expect(text).not.toContain(marker("answer", i));
    }
    expect(text).toContain("Earlier in this session");
  });

  it("drops turns older than both the recent and condensed windows entirely", () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      turn({ requestDescription: marker("request", i), finalText: marker("answer", i) })
    );
    const text = formatConversationHistory(history);
    // Recent window: last 5 (15-19). Condensed window: the 10 before that (5-14). Turns 0-4 are
    // older than both and should be gone completely.
    for (const i of [0, 1, 2, 3, 4]) {
      expect(text).not.toContain(marker("request", i));
    }
    expect(text).toContain(marker("request", 5));
    expect(text).toContain(marker("request", 19));
  });

  it("omits the condensed section entirely when history fits within the recent window", () => {
    const history = Array.from({ length: 3 }, (_, i) =>
      turn({ requestDescription: marker("request", i), finalText: marker("answer", i) })
    );
    const text = formatConversationHistory(history);
    expect(text).not.toContain("Earlier in this session");
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

  it("uses a turn's cached summary instead of its bare request text in the condensed tier", () => {
    const history = Array.from({ length: 8 }, (_, i) =>
      turn({ requestDescription: marker("request", i), finalText: marker("answer", i) })
    );
    // Turn 0 falls into the condensed tier (outside the 5-turn recent window). Give it a summary.
    history[0].summary = "SUMMARIZED: turn zero was about X";

    const text = formatConversationHistory(history);
    expect(text).toContain("SUMMARIZED: turn zero was about X");
    // The raw request text for the summarized turn should no longer appear on its own.
    expect(text).not.toContain(marker("request", 0));
    // A turn without a summary still falls back to its bare request text.
    expect(text).toContain(marker("request", 1));
  });
});

describe("findTurnsNeedingSummary", () => {
  it("returns nothing when history fits entirely within the recent window", () => {
    const history = Array.from({ length: 3 }, (_, i) => turn({ requestDescription: `req ${i}` }));
    expect(findTurnsNeedingSummary(history)).toEqual([]);
  });

  it("returns turns in the condensed tier that don't have a summary yet", () => {
    const history = Array.from({ length: 8 }, (_, i) => turn({ requestDescription: `req ${i}` }));
    const needing = findTurnsNeedingSummary(history);
    // Turns 0-2 are outside the 5-turn recent window (indices 3-7) -- exactly the condensed tier.
    expect(needing.map((t) => t.requestDescription)).toEqual(["req 0", "req 1", "req 2"]);
  });

  it("excludes turns that already have a summary", () => {
    const history = Array.from({ length: 8 }, (_, i) => turn({ requestDescription: `req ${i}` }));
    history[0].summary = "already summarized";
    const needing = findTurnsNeedingSummary(history);
    expect(needing.map((t) => t.requestDescription)).toEqual(["req 1", "req 2"]);
  });

  it("excludes turns older than the condensed window too, since they're never rendered", () => {
    const history = Array.from({ length: 20 }, (_, i) => turn({ requestDescription: `req ${i}` }));
    const needing = findTurnsNeedingSummary(history);
    // Recent: last 5 (15-19). Condensed: the 10 before that (5-14). Turns 0-4 are past both.
    expect(needing).toHaveLength(10);
    expect(needing[0].requestDescription).toBe("req 5");
    expect(needing.at(-1)?.requestDescription).toBe("req 14");
  });

  it("is idempotent once every eligible turn has a summary", () => {
    const history = Array.from({ length: 8 }, (_, i) => turn({ requestDescription: `req ${i}` }));
    for (const t of findTurnsNeedingSummary(history)) {
      t.summary = `summary of ${t.requestDescription}`;
    }
    expect(findTurnsNeedingSummary(history)).toEqual([]);
  });
});
