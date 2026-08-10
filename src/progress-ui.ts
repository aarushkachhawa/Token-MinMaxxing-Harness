import { clearLine, cursorTo } from "node:readline";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const MIN_CONTENT_WIDTH = 20;
const MAX_CONTENT_WIDTH = 96;
const CTRL_C = 3;

/**
 * A collapsible progress indicator for one in-flight request: a self-updating spinner + current
 * step label by default, expandable (press 'e') into a bordered, append-only box of every
 * detailed progress line seen so far. "Scrolling" the box is just the terminal's own native
 * scrollback -- there's no custom viewport -- which keeps this simple and avoids re-implementing
 * a scroll region.
 *
 * Only animates/listens for keypresses when both stdin and stdout are real TTYs; falls back to
 * plain sequential console.log lines for piped/non-interactive output (redirected to a file, a
 * test harness, etc.), where raw-mode keypress handling and \r-based redraws don't apply.
 */
export class ProgressUI {
  private readonly interactive: boolean;
  private frameIndex = 0;
  private timer: NodeJS.Timeout | null = null;
  private step = "";
  private expanded = false;
  private boxOpen = false;
  private rawModeActive = false;

  constructor() {
    this.interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  }

  start(initialStep: string): void {
    this.step = initialStep;
    this.expanded = false;
    this.boxOpen = false;
    if (!this.interactive) {
      console.log(initialStep);
      return;
    }
    this.enableKeypress();
    this.paintCollapsed();
    this.startTimer();
  }

  /** Updates the short label shown on the collapsed spinner line. */
  setStep(step: string): void {
    this.step = step;
    if (!this.interactive) {
      console.log(step);
      return;
    }
    if (this.expanded) {
      this.writeBoxLine(step);
    } else {
      this.paintCollapsed();
    }
  }

  /** A detail line that only ever appears in the expanded box, never on the collapsed line. */
  log(line: string): void {
    if (!this.interactive) {
      console.log(line);
      return;
    }
    if (this.expanded) {
      this.writeBoxLine(line);
    }
  }

  /**
   * Stops the spinner/keypress listener and closes the box border (if open) so the terminal is
   * back to normal cooked-mode, print-as-usual state. Safe to call even if never started, or
   * already stopped -- every phase of a request calls this between steps, and callers should also
   * call it in a `finally` as a safety net so a mid-phase exception can't leave raw mode stuck on.
   */
  stop(): void {
    if (!this.interactive) return;
    this.stopTimer();
    this.closeBoxIfNeeded();
    if (!this.expanded) this.clearCollapsedLine();
    this.disableKeypress();
  }

  /**
   * Yields the terminal to a nested prompt (e.g. the write-approval gate's own readline) for the
   * duration of `fn`: stops animating and releases raw mode first, restores afterward. Needed so
   * the spinner and a nested cooked-mode prompt never fight over stdin at the same time.
   */
  async withPaused<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.interactive) return fn();
    const wasExpanded = this.expanded;
    this.stopTimer();
    this.closeBoxIfNeeded();
    this.clearCollapsedLine();
    this.disableKeypress();
    try {
      return await fn();
    } finally {
      this.expanded = wasExpanded;
      this.enableKeypress();
      if (this.expanded) {
        this.writeBoxLine(this.step);
      } else {
        this.paintCollapsed();
      }
      this.startTimer();
    }
  }

  private toggleExpand(): void {
    this.expanded = !this.expanded;
    if (this.expanded) {
      this.clearCollapsedLine();
      this.writeBoxLine(this.step);
    } else {
      this.closeBoxIfNeeded();
      this.paintCollapsed();
    }
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      if (!this.expanded) this.paintCollapsed();
    }, SPINNER_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private openBoxIfNeeded(): void {
    if (this.boxOpen) return;
    process.stdout.write(`┌${"─".repeat(this.contentWidth() + 2)}┐\n`);
    this.boxOpen = true;
  }

  private closeBoxIfNeeded(): void {
    if (!this.boxOpen) return;
    process.stdout.write(`└${"─".repeat(this.contentWidth() + 2)}┘\n`);
    this.boxOpen = false;
  }

  private writeBoxLine(text: string): void {
    this.openBoxIfNeeded();
    const width = this.contentWidth();
    for (const wrapped of wrapText(text, width)) {
      process.stdout.write(`│ ${wrapped.padEnd(width)} │\n`);
    }
  }

  private contentWidth(): number {
    const terminalWidth = process.stdout.columns ?? 80;
    return Math.max(MIN_CONTENT_WIDTH, Math.min(terminalWidth - 4, MAX_CONTENT_WIDTH));
  }

  private paintCollapsed(): void {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(`${SPINNER_FRAMES[this.frameIndex]} ${this.step}  (press e to expand)`);
  }

  private clearCollapsedLine(): void {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
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
    if (this.rawModeActive) return;
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
