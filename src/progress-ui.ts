import { theme } from "./cli-theme.js";

/**
 * A step-by-step progress indicator for one in-flight request: prints one colored line each time
 * the current step actually changes.
 *
 * Earlier versions tried to redraw a single line in place instead of printing a new one per step
 * -- first via `readline`'s clearLine()/cursorTo() ANSI escape sequences, then via a plain `\r`
 * carriage return. Both failed in terminal front-ends that don't interpret cursor-control
 * characters at all: instead of overwriting, every tick just concatenated onto one unbroken line,
 * which is worse than the plain-lines problem either was meant to fix. Printing one real line per
 * distinct step change is the only technique that's guaranteed correct in *any* text-consuming
 * environment, real terminal or not, since it depends on nothing but `\n`.
 *
 * There was also an expandable detail box (press 'e', toggling a bordered box of every log() line
 * along the way) with its own raw-mode keypress listener. Removed for looking cluttered rather
 * than useful in practice -- log() is now a no-op so call sites don't need to change, kept in case
 * a detail view comes back in a different form later. Dropping the listener is also a nice side
 * effect for Ctrl+C: raw mode is what made ProgressUI swallow that keystroke and need to manually
 * re-emit SIGINT in the first place, so without it, Ctrl+C during a request now goes through the
 * terminal's normal signal delivery instead.
 */
export class ProgressUI {
  private step = "";

  start(initialStep: string): void {
    this.step = "";
    this.setStep(initialStep);
  }

  /** Prints a new line for the current step -- a no-op if it hasn't actually changed. */
  setStep(step: string): void {
    if (step === this.step) return;
    this.step = step;
    console.log(`${theme.neon("›")} ${step}`);
  }

  /** No-op -- see the class doc comment. Kept so existing call sites don't need to change. */
  log(_line: string): void {}

  /** No-op -- kept so existing call sites (a `finally` safety net, mainly) don't need to change. */
  stop(): void {}

  /** No terminal state to yield anymore -- kept so existing call sites don't need to change. */
  async withPaused<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
