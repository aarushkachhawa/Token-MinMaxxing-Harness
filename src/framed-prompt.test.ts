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
  /** Everything the prompt painted, in order -- the erase-on-submit tests assert on the tail. */
  let writes: string[];

  /** Fakes a terminal width; process.stdout has no `columns` under vitest, so it must be defined. */
  function setColumns(columns: number): void {
    Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  }

  /** Waits out the idle frame's trailing-edge repaint. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

  afterEach(() => {
    delete (process.stdout as unknown as { columns?: number }).columns;
    // Each prompt subscribes to resize for its lifetime; most tests here never release theirs, so
    // without this they'd pile up on the shared process.stdout and all repaint at once.
    process.stdout.removeAllListeners("resize");
  });

  beforeEach(() => {
    writes = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves with typed characters on Enter", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    const result = prompt.ask();
    send("hi");
    send("\r");
    await expect(result).resolves.toBe("hi");
  });

  it("backspace removes the last character", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    const result = prompt.ask();
    send("hit");
    send("\x7f");
    send("\r");
    await expect(result).resolves.toBe("hi");
  });

  it("left arrow moves the cursor so a later insert lands in the middle", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    const result = prompt.ask();
    send("ac");
    send("\x1b[D");
    send("b");
    send("\r");
    await expect(result).resolves.toBe("abc");
  });

  it("Ctrl+A and Ctrl+E jump to the start and end of the line", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    const result = prompt.ask();
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
    const prompt = new FramedPrompt("> ", stream);
    const result = prompt.ask();
    send("abcd");
    send("\x1b[D"); // cursor now before the 'd'
    send("\x15"); // Ctrl+U
    send("\r");
    await expect(result).resolves.toBe("d");
  });

  it("an unrecognized escape sequence is swallowed, not inserted into the line", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    const result = prompt.ask();
    send("a\x1b[Hb"); // Home key (unhandled) sandwiched between two characters
    send("\r");
    await expect(result).resolves.toBe("ab");
  });

  it("a pasted multi-line chunk resolves the first line and queues the rest", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    const first = prompt.ask();
    send("line1\nline2\nline3");
    await expect(first).resolves.toBe("line1");

    await expect(prompt.ask()).resolves.toBe("line2");
    await expect(prompt.ask()).resolves.toBe("line3");
  });

  it("a queued line resolves without registering a new data listener", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    const first = prompt.ask();
    send("one\ntwo");
    await first;

    const onCallsBefore = (stream.on as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(prompt.ask()).resolves.toBe("two");
    expect((stream.on as ReturnType<typeof vi.fn>).mock.calls.length).toBe(onCallsBefore);
  });

  it("Ctrl+C re-emits SIGINT instead of being inserted or submitted", () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    const handler = vi.fn();
    process.once("SIGINT", handler);
    void prompt.ask(); // deliberately not awaited -- Ctrl+C never resolves this call
    send("\x03");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("enables raw mode while waiting and disables it once resolved", async () => {
    const { stream, send, setRawModeCalls } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    const result = prompt.ask();
    expect(setRawModeCalls).toEqual([true]);
    send("x\r");
    await result;
    expect(setRawModeCalls).toEqual([true, false]);
  });

  it("erases the typed frame on submit and leaves an empty one in its place", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    const result = prompt.ask();
    send("hi\r");
    await result;
    // Up one row onto the top divider and erase to end of screen (the typed line is gone), then
    // a fresh three-row frame with the cursor parked back on its top row.
    const tail = writes.slice(-4);
    expect(tail[0]).toBe("\x1b[1A");
    expect(tail[1]).toBe("\r\x1b[0J");
    expect(tail[2].split("\n")).toHaveLength(3);
    expect(tail[2]).toContain("> ");
    expect(tail[3]).toBe("\r\x1b[1A\x1b[2C");
  });

  it("erases every row of a frame the input had grown to span", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    const result = prompt.ask();
    // 100 chars against the 80-column fallback width wraps the input onto a second row, putting
    // the cursor one row below the first -- the erase has to climb past that row too.
    send("x".repeat(100));
    send("\r");
    await result;
    expect(writes.slice(-4, -2)).toEqual(["\x1b[2A", "\r\x1b[0J"]);
  });

  describe("the pinned frame", () => {
    it("show() draws three rows and parks the cursor in the input row", () => {
      const { stream } = createFakeStream();
      new FramedPrompt("> ", stream).show();
      expect(writes).toHaveLength(2);
      expect(writes[0].split("\n")).toHaveLength(3);
      expect(writes[1]).toBe("\r\x1b[1A\x1b[2C");
    });

    it("show() is idempotent -- a second call paints nothing", () => {
      const { stream } = createFakeStream();
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      writes.length = 0;
      prompt.show();
      expect(writes).toEqual([]);
    });

    it("print() drops the line where the frame was and redraws the frame under it", () => {
      const { stream } = createFakeStream();
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      writes.length = 0;
      prompt.print("hello");
      // Erase the frame, emit the line on the row it occupied, then the frame one row lower --
      // which is what makes the frame scoot down the screen rather than stay put or vanish.
      expect(writes[0]).toBe("\x1b[1A\r\x1b[0J");
      expect(writes[1]).toBe("hello\n");
      expect(writes[2].split("\n")).toHaveLength(3);
      expect(writes[3]).toBe("\r\x1b[1A\x1b[2C");
    });

    it("print() without a frame up is a plain write", () => {
      const { stream } = createFakeStream();
      new FramedPrompt("> ", stream).print("hello");
      expect(writes).toEqual(["hello\n"]);
    });

    it("replaceLast() climbs back over the previous line instead of appending", () => {
      const { stream } = createFakeStream();
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      prompt.print("first");
      writes.length = 0;
      prompt.replaceLast("second");
      expect(writes.slice(0, 3)).toEqual(["\x1b[1A\r\x1b[0J", "\x1b[1A", "\r\x1b[0Jsecond\n"]);
    });

    it("replaceLast() climbs over every row a wrapped line took", () => {
      const { stream } = createFakeStream();
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      prompt.print("x".repeat(161)); // three rows at the 80-column fallback width
      writes.length = 0;
      prompt.replaceLast("short");
      expect(writes[1]).toBe("\x1b[3A");
    });

    it("withHidden() takes the frame down for the callback and puts it back", async () => {
      const { stream } = createFakeStream();
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      writes.length = 0;
      await prompt.withHidden(async () => {
        expect(writes).toEqual(["\x1b[1A\r\x1b[0J"]);
      });
      expect(writes.at(-1)).toBe("\r\x1b[1A\x1b[2C");
    });

    it("redraws at the new width on resize, so the dividers still span the window", async () => {
      const { stream } = createFakeStream();
      setColumns(80);
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      writes.length = 0;

      setColumns(40);
      process.stdout.emit("resize");
      await settle();

      // Frame down, frame back up -- the new one drawn against the window as it is now.
      expect(writes[0]).toBe("\x1b[1A\r\x1b[0J");
      const rows = writes[1].split("\n");
      expect(rows[0]).toHaveLength(40);
      expect(rows[2]).toHaveLength(40);
      prompt.release();
    });

    it("repaints once for a drag's worth of resize events, at the size it settles on", async () => {
      const { stream } = createFakeStream();
      setColumns(80);
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      writes.length = 0;

      for (const width of [78, 70, 61, 55, 44]) {
        setColumns(width);
        process.stdout.emit("resize");
      }
      await settle();

      // One erase and one redraw, not five of each -- and drawn at 44, the size the drag ended on.
      expect(writes).toHaveLength(3);
      expect(writes[1].split("\n")[0]).toHaveLength(44);
      prompt.release();
    });

    it("a resize paints nothing while the frame is down", async () => {
      const { stream } = createFakeStream();
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      prompt.hide();
      writes.length = 0;
      process.stdout.emit("resize");
      await settle();
      expect(writes).toEqual([]);
      prompt.release();
    });

    it("a resize mid-edit reflows the line being typed rather than repainting an empty frame", async () => {
      const { stream, send } = createFakeStream();
      setColumns(80);
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      const result = prompt.ask();
      send("some typed text");
      writes.length = 0;

      setColumns(40);
      process.stdout.emit("resize");

      const painted = writes.join("");
      expect(painted).toContain("some typed text");
      expect(painted).toContain("\u2500".repeat(40));

      send("\r");
      await result;
      prompt.release();
    });

    it("release() stops listening, so a later resize paints nothing", async () => {
      const { stream } = createFakeStream();
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      prompt.release();
      writes.length = 0;
      process.stdout.emit("resize");
      await settle();
      expect(writes).toEqual([]);
    });

    it("release() cancels a repaint that was still pending", async () => {
      const { stream } = createFakeStream();
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      process.stdout.emit("resize");
      prompt.release(); // mid-drag shutdown: the queued repaint must not fire onto a dead frame
      writes.length = 0;
      await settle();
      expect(writes).toEqual([]);
    });

    it("replaceLast() measures the previous line at the current width, not the one it was printed at", () => {
      const { stream } = createFakeStream();
      setColumns(100);
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      prompt.print("x".repeat(100)); // one row at 100 columns

      setColumns(50); // ...but two rows at 50
      writes.length = 0;
      prompt.replaceLast("short");
      expect(writes[1]).toBe("\x1b[2A");
      prompt.release();
    });

    it("release() takes the frame down so the shell prompt doesn't land on it", () => {
      const { stream } = createFakeStream();
      const prompt = new FramedPrompt("> ", stream);
      prompt.show();
      writes.length = 0;
      prompt.release();
      expect(writes).toEqual(["\x1b[1A\r\x1b[0J"]);
    });
  });

  it("a queued paste line paints nothing of its own -- no frame, no leftover box", async () => {
    const { stream, send } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    const first = prompt.ask();
    send("one\ntwo");
    await first;

    writes.length = 0;
    await expect(prompt.ask()).resolves.toBe("two");
    expect(writes).toEqual([]);
  });

  it("release() disables raw mode even mid-prompt", () => {
    const { stream, setRawModeCalls } = createFakeStream();
    const prompt = new FramedPrompt("> ", stream);
    void prompt.ask();
    expect(setRawModeCalls).toEqual([true]);
    prompt.release();
    expect(setRawModeCalls).toEqual([true, false]);
  });
});
