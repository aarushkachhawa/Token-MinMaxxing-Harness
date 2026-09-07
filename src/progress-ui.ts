import { theme, truncateVisible } from "./cli-theme.js";

/**
 * A step-by-step progress indicator for one in-flight request: keeps a single status line that
 * rewrites itself in place each time the current step actually changes, so a whole request's
 * "Thinking... -> Planning... -> Running ..." sequence occupies one row rather than a growing
 * stack of them.
 *
 * In-place redraw is used *only* when the output stream is a real TTY. An earlier version of this
 * class redrew unconditionally (first with `readline`'s clearLine()/cursorTo(), then with a bare
 * `\r`) and broke in front-ends that don't interpret cursor-control characters at all: every tick
 * concatenated onto one unbroken line instead of overwriting. Gating on isTTY keeps that fix --
 * anything that isn't a terminal (piped output, a captured log, a test) still gets one plain
 * `\n`-terminated line per distinct step, which depends on nothing but `\n` and so is correct
 * everywhere. Same convention cli-theme.ts already uses to decide whether to emit color, and the
 * same cursor-control assumption FramedPrompt makes for its own redraws.
 *
 * The live line is transient until stop() commits it with a newline, so whatever prints next
 * (the deliverable, an approval prompt) starts on its own row instead of overwriting or being
 * overwritten. Lines are truncated to one terminal row: a status line allowed to wrap would leave
 * `\r` returning to the wrong row, which is the same class of bug FramedPrompt's manual chunking
 * exists to avoid.
 *
 * When a `host` is supplied -- the interactive CLI, where FramedPrompt keeps a frame pinned below
 * the transcript -- updating the row with a bare `\r` would fight that frame for the cursor, so
 * the same two operations are delegated instead: the first step of a run is print()ed as a new
 * transcript line and each subsequent one replaceLast()es it. The line is already newline-
 * terminated by the host, so stop() has nothing to commit and only has to stop claiming the row.
 *
 * There was also an expandable detail box (press 'e', toggling a bordered box of every log() line
 * along the way) with its own raw-mode keypress listener. Removed for looking cluttered rather
 * than useful in practice -- log() is now a no-op so call sites don't need to change, kept in case
 * a detail view comes back in a different form later. Dropping the listener is also a nice side
 * effect for Ctrl+C: raw mode is what made ProgressUI swallow that keystroke and need to manually
 * re-emit SIGINT in the first place, so without it, Ctrl+C during a request now goes through the
 * terminal's normal signal delivery instead.
 */
/**
 * The subset of FramedPrompt's sticky-frame API this class needs: somewhere to put a line that
 * stays above the frame, and a way to rewrite the one it put there last.
 */
export interface ProgressHost {
  print(text: string): void;
  replaceLast(text: string): void;
  withHidden<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ProgressUIOptions {
  /**
   * Renders the status line above a pinned input frame. When omitted, the status line is written
   * straight to `stream` instead (in place on a TTY, one line per step otherwise).
   */
  host?: ProgressHost;
  /** Where in-place updates are written when there's no host. Defaults to process.stdout. */
  stream?: NodeJS.WriteStream;
  /** Force the redraw-in-place path on or off. Defaults to whether `stream` is a TTY. */
  interactive?: boolean;
}

export class ProgressUI {
  private readonly host: ProgressHost | undefined;
  private readonly stream: NodeJS.WriteStream;
  private readonly interactive: boolean;
  private step = "";
  /** True while this class still owns the row its status line is on and may rewrite it. */
  private live = false;

  constructor(options: ProgressUIOptions = {}) {
    this.host = options.host;
    this.stream = options.stream ?? process.stdout;
    this.interactive = options.interactive ?? Boolean(this.stream.isTTY);
  }

  start(initialStep: string): void {
    this.step = "";
    this.setStep(initialStep);
  }

  /** Redraws the status line with the current step -- a no-op if it hasn't actually changed. */
  setStep(step: string): void {
    if (step === this.step) return;
    this.step = step;
    this.render();
  }

  /** No-op -- see the class doc comment. Kept so existing call sites don't need to change. */
  log(_line: string): void {}

  /**
   * Ends the current status line, leaving it on screen as a record of where the request got to
   * and making sure the next output starts on a fresh row. Safe to call when nothing is live (the
   * `finally` safety net in cli.ts leans on that).
   */
  stop(): void {
    if (!this.live) return;
    this.live = false;
    // With a host the line was newline-terminated when it was printed; only the bare-stream path
    // has an unterminated row to close off.
    if (!this.host && this.interactive) this.stream.write("\n");
  }

  /**
   * Clears the way for the duration of `fn`, so anything that takes over the terminal in between
   * (an approval gate's own prompt) gets a clean row to draw on instead of appending to a
   * half-written status line -- with a host, that also means taking the pinned frame down. Either
   * way the status line stops being ours to rewrite afterwards, since `fn` has printed over
   * everything below it: the next step starts a new line rather than overwriting `fn`'s output.
   */
  async withPaused<T>(fn: () => Promise<T>): Promise<T> {
    if (this.host) {
      this.live = false;
      return this.host.withHidden(fn);
    }
    const wasLive = this.live;
    this.erase();
    try {
      return await fn();
    } finally {
      if (wasLive) this.render();
    }
  }

  private render(): void {
    const line = `${theme.neon("›")} ${this.step}`;
    if (this.host) {
      if (this.live) this.host.replaceLast(line);
      else this.host.print(line);
      this.live = true;
      return;
    }
    if (!this.interactive) {
      console.log(line);
      return;
    }
    // Stop one column short of the full width: a line that exactly fills the row makes some
    // terminals wrap the cursor onto the next one, which would strand the next `\r` a row below.
    const width = Math.max((this.stream.columns || 80) - 1, 1);
    this.stream.write(`\r\x1b[2K${truncateVisible(line, width)}`);
    this.live = true;
  }

  private erase(): void {
    if (!this.live) return;
    this.live = false;
    this.stream.write("\r\x1b[2K");
  }
}
