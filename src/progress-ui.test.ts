import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgressUI } from "./progress-ui.js";

describe("ProgressUI", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the initial step once on start()", () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Thinking...");
  });

  it("prints a new line when the step actually changes", () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    ui.setStep("Planning...");
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("Planning...");
  });

  it("is a no-op when the step is set to the same value again", () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    ui.setStep("Thinking...");
    expect(logs).toHaveLength(1);
  });

  it("start() resets the tracked step so a repeated initial step still prints", () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    ui.start("Thinking...");
    expect(logs).toHaveLength(2);
  });

  it("log() never prints anything", () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    ui.log("some detail line");
    expect(logs.join("")).not.toContain("some detail line");
  });

  it("stop() does not throw and has no visible effect", () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    expect(() => ui.stop()).not.toThrow();
  });

  it("withPaused runs the callback and returns its result", async () => {
    const ui = new ProgressUI();
    const result = await ui.withPaused(async () => 42);
    expect(result).toBe(42);
  });
});
