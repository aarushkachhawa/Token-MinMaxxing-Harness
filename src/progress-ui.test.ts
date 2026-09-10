import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgressUI } from "./progress-ui.js";

/**
 * Stand-in for a real terminal: records everything written so a test can assert on the exact
 * escape sequences, since that's the whole behavior of the redraw-in-place path.
 */
function fakeTty(columns = 80) {
  const writes: string[] = [];
  const stream = {
    isTTY: true,
    columns,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, writes, all: () => writes.join("") };
}

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
    const ui = new ProgressUI({ interactive: false });
    ui.start("Thinking...");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Thinking...");
  });

  it("prints a new line when the step actually changes", () => {
    const ui = new ProgressUI({ interactive: false });
    ui.start("Thinking...");
    ui.setStep("Planning...");
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("Planning...");
  });

  it("is a no-op when the step is set to the same value again", () => {
    const ui = new ProgressUI({ interactive: false });
    ui.start("Thinking...");
    ui.setStep("Thinking...");
    expect(logs).toHaveLength(1);
  });

  it("start() resets the tracked step so a repeated initial step still prints", () => {
    const ui = new ProgressUI({ interactive: false });
    ui.start("Thinking...");
    ui.start("Thinking...");
    expect(logs).toHaveLength(2);
  });

  it("log() never prints anything", () => {
    const ui = new ProgressUI({ interactive: false });
    ui.start("Thinking...");
    ui.log("some detail line");
    expect(logs.join("")).not.toContain("some detail line");
  });

  it("stop() does not throw and has no visible effect", () => {
    const ui = new ProgressUI({ interactive: false });
    ui.start("Thinking...");
    expect(() => ui.stop()).not.toThrow();
  });

  it("withPaused runs the callback and returns its result", async () => {
    const ui = new ProgressUI({ interactive: false });
    const result = await ui.withPaused(async () => 42);
    expect(result).toBe(42);
  });

  describe("on a TTY", () => {
    it("rewrites one line in place instead of printing a new one per step", () => {
      const tty = fakeTty();
      const ui = new ProgressUI({ stream: tty.stream });
      ui.start("Thinking...");
      ui.setStep("Planning...");

      // Every update starts by returning to column 0 and erasing the row, and none of them emit a
      // newline -- that's what keeps both steps on a single terminal row.
      expect(tty.writes).toHaveLength(2);
      for (const write of tty.writes) expect(write.startsWith("\r\x1b[2K")).toBe(true);
      expect(tty.all()).not.toContain("\n");
      expect(tty.all()).toContain("Thinking...");
      expect(tty.all()).toContain("Planning...");
      expect(logs).toHaveLength(0);
    });

    it("does not redraw when the step is set to the same value again", () => {
      const tty = fakeTty();
      const ui = new ProgressUI({ stream: tty.stream });
      ui.start("Thinking...");
      ui.setStep("Thinking...");
      expect(tty.writes).toHaveLength(1);
    });

    it("truncates a long step to one terminal row so the line can never wrap", () => {
      const tty = fakeTty(20);
      const ui = new ProgressUI({ stream: tty.stream });
      ui.start("x".repeat(200));
      const rendered = tty.all().replace("\r\x1b[2K", "").replace(/\x1b\[[0-9;]*m/g, "");
      expect(rendered.length).toBeLessThanOrEqual(19);
    });

    it("stop() commits the line with a newline so later output starts on a fresh row", () => {
      const tty = fakeTty();
      const ui = new ProgressUI({ stream: tty.stream });
      ui.start("Thinking...");
      ui.stop();
      expect(tty.writes.at(-1)).toBe("\n");
    });

    it("stop() writes nothing when no line is live", () => {
      const tty = fakeTty();
      const ui = new ProgressUI({ stream: tty.stream });
      ui.stop();
      ui.start("Thinking...");
      ui.stop();
      ui.stop();
      expect(tty.writes.filter((w) => w === "\n")).toHaveLength(1);
    });

    it("withPaused erases the live line and redraws it afterwards", async () => {
      const tty = fakeTty();
      const ui = new ProgressUI({ stream: tty.stream });
      ui.start("Running...");
      await ui.withPaused(async () => {
        // Mid-callback the row has been cleared, so an approval prompt gets a clean line.
        expect(tty.writes.at(-1)).toBe("\r\x1b[2K");
      });
      expect(tty.writes.at(-1)).toContain("Running...");
    });

    it("withPaused leaves the row alone when nothing was live", async () => {
      const tty = fakeTty();
      const ui = new ProgressUI({ stream: tty.stream });
      await ui.withPaused(async () => {});
      expect(tty.writes).toHaveLength(0);
    });
  });

  describe("with a sticky-frame host", () => {
    function fakeHost() {
      const calls: Array<[string, string]> = [];
      const host = {
        print: (text: string) => calls.push(["print", text]),
        replaceLast: (text: string) => calls.push(["replaceLast", text]),
        withHidden: async <T>(fn: () => Promise<T>) => {
          calls.push(["withHidden", "start"]);
          const result = await fn();
          calls.push(["withHidden", "end"]);
          return result;
        },
      };
      return { host, calls };
    }

    it("prints the first step, then rewrites that same entry for later ones", () => {
      const { host, calls } = fakeHost();
      const ui = new ProgressUI({ host });
      ui.start("Thinking...");
      ui.setStep("Planning...");
      ui.setStep("Running...");
      expect(calls.map((c) => c[0])).toEqual(["print", "replaceLast", "replaceLast"]);
      expect(calls[2][1]).toContain("Running...");
    });

    it("writes nothing to the raw stream -- the host owns the cursor", () => {
      const tty = fakeTty();
      const { host } = fakeHost();
      const ui = new ProgressUI({ host, stream: tty.stream });
      ui.start("Thinking...");
      ui.setStep("Planning...");
      ui.stop();
      expect(tty.writes).toEqual([]);
    });

    it("goes through the host to hide the frame while a gate has the terminal", async () => {
      const { host, calls } = fakeHost();
      const ui = new ProgressUI({ host });
      ui.start("Thinking...");
      await ui.withPaused(async () => 7);
      expect(calls.map((c) => c[0])).toEqual(["print", "withHidden", "withHidden"]);
    });

    it("starts a fresh entry after a pause rather than overwriting the gate's output", async () => {
      const { host, calls } = fakeHost();
      const ui = new ProgressUI({ host });
      ui.start("Thinking...");
      await ui.withPaused(async () => {});
      calls.length = 0;
      ui.setStep("Planning...");
      expect(calls[0][0]).toBe("print");
    });

    it("start() after stop() begins a new entry instead of rewriting the finished one", () => {
      const { host, calls } = fakeHost();
      const ui = new ProgressUI({ host });
      ui.start("Thinking...");
      ui.stop();
      calls.length = 0;
      ui.start("Compacting older context...");
      expect(calls[0][0]).toBe("print");
    });
  });
});
