import { theme } from "./cli-theme.js";

const MIN_CONTENT_WIDTH = 20;
const MAX_CONTENT_WIDTH = 96;
const CTRL_C = 3;

/**
 * A step-by-step progress indicator for one in-flight request: prints one colored line each time
 * the current step actually changes, plus an optional expandable box (press 'e', only available
 * when stdin is a real TTY) with every detail line logged along the way.
 *
 * Earlier versions tried to redraw a single line in place instead of printing a new one per step
 * -- first via `readline`'s clearLine()/cursorTo() ANSI escape sequences, then via a plain `\r`
 * carriage return. Both failed in terminal front-ends that don't interpret cursor-control
 * characters at all: instead of overwriting, every tick just concatenated onto one unbroken line,
 * which is worse than the plain-lines problem either was meant to fix. Printing one real line per
 * distinct step change is the only technique that's guaranteed correct in *any* text-consuming
 * environment, real terminal or not, since it depends on nothing but `\n` -- there's no
 * animation to lose, just a short, readable log of the phases a request actually went through.
 */
export class ProgressUI {
  private readonly canListenForKeypress: boolean;
  private step = "";
  private expanded = false;
  private boxOpen = false;
  private rawModeActive = false;

  constructor() {
    this.canListenForKeypress = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  }

  start(initialStep: string): void {
    this.step = "";
    this.expanded = false;
    this.boxOpen = false;
    this.enableKeypress();
    this.setStep(initialStep);
  }

  /** Prints a new line for the current step -- a no-op if it hasn't actually changed. */
  setStep(step: string): void {
    if (step === this.step) return;
    this.step = step;
    if (this.expanded) {
      this.writeBoxLine(step);
    } else {
      const hint = this.canListenForKeypress ? theme.dim("  (press e to expand)") : "";
      console.log(`${theme.neon("›")} ${step}${hint}`);
    }
  }

  /** A detail line that only ever appears in the expanded box, never on the collapsed line. */
  log(line: string): void {
    if (this.expanded) {
      this.writeBoxLine(line);
    }
  }

  /**
   * Closes the box border (if open) and disables the keypress listener. Safe to call even if
   * never started, or already stopped -- every phase of a request calls this between steps, and
   * callers should also call it in a `finally` as a safety net so a mid-phase exception can't
   * leave raw mode stuck on.
   */
  stop(): void {
    this.closeBoxIfNeeded();
    this.disableKeypress();
  }

  /**
   * Yields the terminal to a nested prompt (e.g. the write-approval gate's own readline) for the
   * duration of `fn`: closes the box and releases raw mode first, restores both afterward. Needed
   * so an open box border and a nested cooked-mode prompt never fight over stdin/stdout at the
   * same time.
   */
  async withPaused<T>(fn: () => Promise<T>): Promise<T> {
    const wasExpanded = this.expanded;
    this.closeBoxIfNeeded();
    this.disableKeypress();
    try {
      return await fn();
    } finally {
      this.expanded = wasExpanded;
      this.enableKeypress();
      if (this.expanded) {
        this.writeBoxLine(this.step);
      }
    }
  }

  private toggleExpand(): void {
    this.expanded = !this.expanded;
    if (this.expanded) {
      this.writeBoxLine(this.step);
    } else {
      this.closeBoxIfNeeded();
    }
  }

  private openBoxIfNeeded(): void {
    if (this.boxOpen) return;
    process.stdout.write(theme.neon(`┌${"─".repeat(this.contentWidth() + 2)}┐`) + "\n");
    this.boxOpen = true;
  }

  private closeBoxIfNeeded(): void {
    if (!this.boxOpen) return;
    process.stdout.write(theme.neon(`└${"─".repeat(this.contentWidth() + 2)}┘`) + "\n");
    this.boxOpen = false;
  }

  private writeBoxLine(text: string): void {
    this.openBoxIfNeeded();
    const width = this.contentWidth();
    const border = theme.neon("│");
    for (const wrapped of wrapText(text, width)) {
      process.stdout.write(`${border} ${wrapped.padEnd(width)} ${border}\n`);
    }
  }

  private contentWidth(): number {
    const terminalWidth = process.stdout.columns ?? 80;
    return Math.max(MIN_CONTENT_WIDTH, Math.min(terminalWidth - 4, MAX_CONTENT_WIDTH));
  }

  private readonly onData = (chunk: Buffer): void => {
    if (chunk.length === 1 && chunk[0] === CTRL_C) {
      // Raw mode swallows the SIGINT keystroke itself, so re-raise it for the process's own
      // handler instead of letting Ctrl+C silently do nothing.
      process.emit("SIGINT");
      return;
    }
    const key = chunk.toString();
    if (key === "e" || key === "E") {
      this.toggleExpand();
    }
  };

  private enableKeypress(): void {
    if (!this.canListenForKeypress || this.rawModeActive) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    this.rawModeActive = true;
  }

  private disableKeypress(): void {
    if (!this.rawModeActive) return;
    process.stdin.off("data", this.onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    this.rawModeActive = false;
  }
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let remaining = paragraph;
    if (remaining.length === 0) {
      lines.push("");
      continue;
    }
    while (remaining.length > width) {
      lines.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    lines.push(remaining);
  }
  return lines;
}

// Last-resort safety net: if a raw-mode TTY is somehow still active when the process exits (an
// uncaught exception, a code path that skipped ProgressUI.stop()), force it back to cooked mode
// so the user's shell isn't left broken after this process ends.
process.on("exit", () => {
  if (process.stdin.isTTY && (process.stdin as unknown as { isRaw?: boolean }).isRaw) {
    process.stdin.setRawMode(false);
  }
});
