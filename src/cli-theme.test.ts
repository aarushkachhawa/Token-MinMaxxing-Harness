import { describe, expect, it } from "vitest";
import { formatResponse, formatUserMessage, truncateVisible, visibleLength } from "./cli-theme.js";

/**
 * Color is off in these tests (stdout isn't a TTY under vitest, see cli-theme's colorEnabled), so
 * markers and text come through unpainted and can be asserted on as plain strings.
 */
describe("formatResponse", () => {
  it("marks the first line and hangs the rest under it", () => {
    const lines = formatResponse("a ".repeat(200).trim()).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].startsWith("✦ ")).toBe(true);
    for (const line of lines.slice(1)) expect(line.startsWith("  ")).toBe(true);
  });

  it("renders **bold** markup instead of leaving the asterisks on screen", () => {
    const out = formatResponse("a **bold** word");
    expect(out).not.toContain("**");
    expect(out).toContain("bold");
  });
});

describe("formatUserMessage", () => {
  it("uses its own marker so a turn is distinguishable from the answer it produced", () => {
    expect(formatUserMessage("fix the thing").startsWith("❯ ")).toBe(true);
    expect(formatUserMessage("fix the thing")).not.toContain("✦");
  });

  it("hangs wrapped lines under the marker, same shape as an answer", () => {
    const lines = formatUserMessage("word ".repeat(200).trim()).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) expect(line.startsWith("  ")).toBe(true);
  });

  it("leaves ** verbatim -- this is the user's literal text, not markup to interpret", () => {
    expect(formatUserMessage("what does **this** mean")).toContain("**this**");
  });

  it("keeps every word of a multi-paragraph request", () => {
    const out = formatUserMessage("first line\nsecond line");
    expect(out).toContain("first line");
    expect(out).toContain("second line");
  });
});

describe("visibleLength / truncateVisible", () => {
  it("ignores color escapes when measuring", () => {
    expect(visibleLength("\x1b[1mabc\x1b[0m")).toBe(3);
  });

  it("truncates by visible columns and closes the color it cut", () => {
    const out = truncateVisible("\x1b[1mabcdef\x1b[0m", 3);
    expect(visibleLength(out)).toBe(3);
    expect(out.endsWith("\x1b[0m")).toBe(true);
  });
});
