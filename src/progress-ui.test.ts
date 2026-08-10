import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgressUI } from "./progress-ui.js";

/**
 * These tests mock a real TTY (isTTY=true on both stdin/stdout) to exercise the raw-mode/spinner
 * code paths that piped/CI stdin can never reach. The scenario this project cares most about:
 * raw mode must always end up back off, even across expand/collapse and even when a nested
 * prompt (withPaused) runs in between -- a stuck raw-mode TTY breaks the user's actual shell
 * after the process exits, not just this program.
 */
describe("ProgressUI (mocked TTY)", () => {
  let writes: string[];
  let rawModeCalls: boolean[];
  let dataListeners: Array<(chunk: Buffer) => void>;
  let originalStdoutIsTTY: boolean | undefined;
  let originalStdinIsTTY: boolean | undefined;
  let originalColumns: number | undefined;
  let originalSetRawMode: unknown;

  beforeEach(() => {
    writes = [];
    rawModeCalls = [];
    dataListeners = [];
    vi.useFakeTimers();

    originalStdoutIsTTY = process.stdout.isTTY;
    originalStdinIsTTY = process.stdin.isTTY;
    originalColumns = process.stdout.columns;
    originalSetRawMode = (process.stdin as { setRawMode?: unknown }).setRawMode;

    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    (process.stdin as unknown as { isTTY: boolean }).isTTY = true;
    (process.stdout as unknown as { columns: number }).columns = 80;
    if (typeof process.stdin.setRawMode !== "function") {
      (process.stdin as unknown as { setRawMode: unknown }).setRawMode = () => process.stdin;
    }

    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      writes.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stdin, "setRawMode").mockImplementation(((mode: boolean) => {
      rawModeCalls.push(mode);
      return process.stdin;
    }) as typeof process.stdin.setRawMode);
    vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "on").mockImplementation(((event: string, listener: (chunk: Buffer) => void) => {
      if (event === "data") dataListeners.push(listener);
      return process.stdin;
    }) as typeof process.stdin.on);
    vi.spyOn(process.stdin, "off").mockImplementation((() => process.stdin) as typeof process.stdin.off);
  });

  afterEach(() => {
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = originalStdoutIsTTY;
    (process.stdin as unknown as { isTTY: boolean | undefined }).isTTY = originalStdinIsTTY;
    (process.stdout as unknown as { columns: number | undefined }).columns = originalColumns;
    (process.stdin as unknown as { setRawMode: unknown }).setRawMode = originalSetRawMode;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function pressKey(chunk: string | number[]): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    for (const listener of dataListeners) listener(buf);
  }

  it("enables raw mode on start and disables it on stop", () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    expect(rawModeCalls).toEqual([true]);
    ui.stop();
    expect(rawModeCalls).toEqual([true, false]);
  });

  it("stop() is a safe no-op if called without a matching start()", () => {
    const ui = new ProgressUI();
    expect(() => ui.stop()).not.toThrow();
    expect(rawModeCalls).toEqual([]);
  });

  it("pressing 'e' opens a bordered box containing the current step", () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    writes.length = 0;
    pressKey("e");
    const output = writes.join("");
    expect(output).toContain("┌");
    expect(output).toContain("Thinking...");
    ui.stop();
  });

  it("pressing 'e' again collapses the box and closes its border", () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    pressKey("e");
    writes.length = 0;
    pressKey("e");
    expect(writes.join("")).toContain("└");
    ui.stop();
  });

  it("log() lines are hidden while collapsed and visible once expanded", () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    ui.log("hidden detail");
    expect(writes.join("")).not.toContain("hidden detail");

    pressKey("e");
    writes.length = 0;
    ui.log("visible detail");
    expect(writes.join("")).toContain("visible detail");
    ui.stop();
  });

  it("stop() closes the box and disables raw mode even while still expanded", () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    pressKey("e");
    writes.length = 0;
    ui.stop();
    expect(writes.join("")).toContain("└");
    expect(rawModeCalls.at(-1)).toBe(false);
  });

  it("withPaused releases raw mode for the duration of the callback and restores it after", async () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    rawModeCalls.length = 0;

    let rawModeDuringCallback: boolean | undefined;
    await ui.withPaused(async () => {
      rawModeDuringCallback = rawModeCalls.at(-1);
    });

    expect(rawModeDuringCallback).toBe(false);
    expect(rawModeCalls.at(-1)).toBe(true);
    ui.stop();
  });

  it("withPaused restores the box if it was expanded before pausing", async () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    pressKey("e");

    await ui.withPaused(async () => {});

    writes.length = 0;
    ui.log("still expanded");
    expect(writes.join("")).toContain("still expanded");
    ui.stop();
  });

  it("a Ctrl+C keystroke re-emits SIGINT instead of being silently swallowed", () => {
    const ui = new ProgressUI();
    const handler = vi.fn();
    process.once("SIGINT", handler);
    ui.start("Thinking...");
    pressKey([3]);
    expect(handler).toHaveBeenCalledTimes(1);
    ui.stop();
  });

  it("start() resets expand state so each new request begins collapsed", () => {
    const ui = new ProgressUI();
    ui.start("Thinking...");
    pressKey("e");
    ui.stop();

    ui.start("Next request...");
    writes.length = 0;
    ui.log("should stay hidden");
    expect(writes.join("")).not.toContain("should stay hidden");
    ui.stop();
  });
});
