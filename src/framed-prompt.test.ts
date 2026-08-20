import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FramedPrompt } from "./framed-prompt.js";

/**
 * Exercises the raw-keystroke line editor against a fake input stream (not process.stdin) so
 * these tests don't need to fight over the real TTY -- FramedPrompt accepts any stream shaped
 * like NodeJS.ReadStream via its constructor for exactly this reason.
 */
function createFakeStream() {
  const listeners: Array<(chunk: Buffer) => void> = [];
  const setRawModeCalls: boolean[] = [];
  const stream = {
    on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data") listeners.push(cb);
      return stream;
    }),
    off: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
      return stream;
    }),
    setRawMode: vi.fn((mode: boolean) => {
      setRawModeCalls.push(mode);
      return stream;
    }),
    resume: vi.fn(() => stream),
    pause: vi.fn(() => stream),
  };
  const send = (text: string): void => {
    const buf = Buffer.from(text, "utf8");
    for (const cb of [...listeners]) cb(buf);
  };
  return { stream: stream as unknown as NodeJS.ReadStream, send, setRawModeCalls };
}

describe("FramedPrompt", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves with typed characters on Enter", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt(stream);
    const result = prompt.ask("> ");
    send("hi");
    send("\r");
    await expect(result).resolves.toBe("hi");
  });

  it("backspace removes the last character", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt(stream);
    const result = prompt.ask("> ");
    send("hit");
    send("\x7f");
    send("\r");
    await expect(result).resolves.toBe("hi");
  });

  it("left arrow moves the cursor so a later insert lands in the middle", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt(stream);
    const result = prompt.ask("> ");
    send("ac");
    send("\x1b[D");
    send("b");
    send("\r");
    await expect(result).resolves.toBe("abc");
  });

  it("Ctrl+A and Ctrl+E jump to the start and end of the line", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt(stream);
    const result = prompt.ask("> ");
    send("bc");
    send("\x01"); // Ctrl+A -> start
    send("a");
    send("\x05"); // Ctrl+E -> end
    send("d");
    send("\r");
    await expect(result).resolves.toBe("abcd");
  });

  it("Ctrl+U clears from the start of the line to the cursor", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt(stream);
    const result = prompt.ask("> ");
    send("abcd");
    send("\x1b[D"); // cursor now before the 'd'
    send("\x15"); // Ctrl+U
    send("\r");
    await expect(result).resolves.toBe("d");
  });

  it("an unrecognized escape sequence is swallowed, not inserted into the line", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt(stream);
    const result = prompt.ask("> ");
    send("a\x1b[Hb"); // Home key (unhandled) sandwiched between two characters
    send("\r");
    await expect(result).resolves.toBe("ab");
  });

  it("a pasted multi-line chunk resolves the first line and queues the rest", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt(stream);
    const first = prompt.ask("> ");
    send("line1\nline2\nline3");
    await expect(first).resolves.toBe("line1");

    await expect(prompt.ask("> ")).resolves.toBe("line2");
    await expect(prompt.ask("> ")).resolves.toBe("line3");
  });

  it("a queued line resolves without registering a new data listener", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt(stream);
    const first = prompt.ask("> ");
    send("one\ntwo");
    await first;

    const onCallsBefore = (stream.on as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(prompt.ask("> ")).resolves.toBe("two");
    expect((stream.on as ReturnType<typeof vi.fn>).mock.calls.length).toBe(onCallsBefore);
  });

  it("Ctrl+C re-emits SIGINT instead of being inserted or submitted", () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt(stream);
    const handler = vi.fn();
    process.once("SIGINT", handler);
    void prompt.ask("> "); // deliberately not awaited -- Ctrl+C never resolves this call
    send("\x03");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("enables raw mode while waiting and disables it once resolved", async () => {
    const { stream, send, setRawModeCalls } = createFakeStream();
    const prompt = new FramedPrompt(stream);
    const result = prompt.ask("> ");
    expect(setRawModeCalls).toEqual([true]);
    send("x\r");
    await result;
    expect(setRawModeCalls).toEqual([true, false]);
  });

  it("release() disables raw mode even mid-prompt", () => {
    const { stream, setRawModeCalls } = createFakeStream();
    const prompt = new FramedPrompt(stream);
    void prompt.ask("> ");
    expect(setRawModeCalls).toEqual([true]);
    prompt.release();
    expect(setRawModeCalls).toEqual([true, false]);
  });
});
