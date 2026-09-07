import { promptDivider, visibleLength } from "./cli-theme.js";

const CTRL_C = "\x03";
const CTRL_A = "\x01";
const CTRL_E = "\x05";
const CTRL_U = "\x15";
const BACKSPACE = "\x7f";
const BACKSPACE_ALT = "\x08";
const ARROW_LEFT = "\x1b[D";
const ARROW_RIGHT = "\x1b[C";
const DELETE_KEY = "\x1b[3~";

/**
 * Reads one line of input at a time via raw keystrokes instead of Node's `readline` module, so
 * the caller-drawn frame around the prompt (a divider above and below the input row -- see
 * promptDivider() in cli-theme.ts) survives every redraw and is visible before the user types
 * anything, not just after Enter. Input longer than one terminal row wraps onto additional rows
 * (manually, not via the terminal's own autowrap -- see askLive()'s redraw()), with the bottom
 * divider following it back down.
 *
 * The frame is permanent and bottom-anchored: it's drawn once via show() and stays on screen
 * between turns, not just while a line is being typed. Everything else the CLI prints goes
 * through print()/replaceLast(), which erase the frame, emit the line where the frame's top row
 * was, and redraw the frame directly beneath it. So each printed line pushes the frame one row
 * further down the screen until it reaches the bottom, after which the terminal's own scrolling
 * takes over and the frame simply stays put while the transcript scrolls up behind it -- the
 * behavior you'd get from a real TUI's footer, without needing full screen control.
 *
 * Submitting doesn't tear the frame down either: finish() erases the typed line and immediately
 * redraws an empty frame in its place, leaving the caller to echo the submitted text back in
 * whatever transcript form it likes (that echo is just another print(), so the frame scoots down
 * a row and the message lands where it used to be). What never happens is a spent box left
 * behind: exactly one frame exists, always at the bottom.
 *
 * `readline` can't coexist with a pre-drawn frame: it repaints its prompt with "erase from cursor
 * to end of screen" (`\x1b[0J`) on every redraw, wiping anything drawn below the cursor before
 * it's ever visible -- confirmed by capturing the raw byte stream through a pty. This class also
 * erases to end of screen on every redraw, but it's safe here specifically because it immediately
 * rewrites everything that was erased (the wrapped input rows and a fresh bottom divider) itself,
 * where readline's caller has no way to know a frame exists below to restore. Every line advance
 * is an explicit `\r\n` rather than a bare `\n`, since raw mode can disable the terminal's
 * automatic newline-to-carriage-return translation depending on platform.
 *
 * Deliberately minimal: printable character insertion (including multi-byte, e.g. emoji), left
 * /right arrow movement, backspace/delete, Ctrl+A/Ctrl+E (start/end of line), Ctrl+U (clear line),
 * Enter, and Ctrl+C (re-raised as SIGINT, matching ProgressUI's own handling). No history recall
 * (up/down arrows) and no word-boundary editing (Ctrl+W) -- `readline` gives those away for free,
 * but a caller-drawn frame trades a slice of that for the visual behavior it needs.
 *
 * Multi-line paste support mirrors what `readline` gave the old implementation "for free": a
 * paste containing embedded newlines resolves the first line immediately and queues the rest,
 * returned by subsequent ask() calls with no terminal I/O at all (there's no line to edit, and
 * the caller echoes it like any other), instead of losing everything after the first line the way
 * naively splitting on just the first newline would.
 */
export class FramedPrompt {
  private readonly stream: NodeJS.ReadStream;
  private readonly label: string;
  private queuedLines: string[] = [];
  private rawModeActive = false;
  /**
   * Whether the idle frame is currently on screen. While it is, the cursor is always parked at
   * column 0 of the frame's top row (the upper divider) -- that parked position is what lets
   * hide() erase the frame with a single erase-to-end-of-screen and lets print() drop its line
   * exactly where the frame was.
   */
  private frameVisible = false;
  /** Terminal rows the most recently printed line occupies, so replaceLast() knows how far up to go. */
  private lastLineRows = 0;

  constructor(label: string, stream: NodeJS.ReadStream = process.stdin) {
    this.label = label;
    this.stream = stream;
  }

  /** Draws the idle frame at the cursor and parks the cursor at its top row. Idempotent. */
  show(): void {
    if (this.frameVisible) return;
    const divider = promptDivider();
    // No trailing newline after the last divider: the cursor should end up *on* the frame's
    // bottom row, not below it, so moving back up two rows lands on the top row. Every move here
    // is relative, so drawing the frame at the bottom of the screen (which scrolls) still parks
    // the cursor correctly.
    process.stdout.write(`${divider}\n${this.label}\n${divider}`);
    process.stdout.write("\r\x1b[2A");
    this.frameVisible = true;
  }

  /** Erases the frame, leaving the cursor on the row its top divider occupied. Idempotent. */
  hide(): void {
    if (!this.frameVisible) return;
    process.stdout.write("\x1b[0J");
    this.frameVisible = false;
  }

  /**
   * Emits one transcript entry above the frame: the frame comes down, the text lands on the row
   * it occupied, and the frame is redrawn beneath. `text` may span several lines.
   */
  print(text: string): void {
    const wasVisible = this.frameVisible;
    this.hide();
    process.stdout.write(`${text}\n`);
    this.lastLineRows = rowsOccupied(text);
    if (wasVisible) this.show();
  }

  /**
   * Overwrites the entry printed most recently instead of appending a new one -- how a status
   * line updates itself in place without the frame below it drifting (see ProgressUI). Only
   * meaningful immediately after a print()/replaceLast() with nothing else written in between;
   * a caller that can't guarantee that should print() a fresh line instead.
   */
  replaceLast(text: string): void {
    const wasVisible = this.frameVisible;
    this.hide();
    if (this.lastLineRows > 0) process.stdout.write(`\x1b[${this.lastLineRows}A`);
    process.stdout.write(`\r\x1b[0J${text}\n`);
    this.lastLineRows = rowsOccupied(text);
    if (wasVisible) this.show();
  }

  /**
   * Runs `fn` with the frame off screen, restoring it afterwards -- for anything that takes the
   * terminal over on its own terms (an approval gate's prompt, /models' menu) and would otherwise
   * draw straight through the frame.
   */
  async withHidden<T>(fn: () => Promise<T>): Promise<T> {
    const wasVisible = this.frameVisible;
    this.hide();
    try {
      return await fn();
    } finally {
      if (wasVisible) this.show();
    }
  }

  async ask(): Promise<string> {
    const queued = this.queuedLines.shift();
    if (queued !== undefined) return queued;
    // The live editor repaints the frame region itself, starting from a clean row.
    this.hide();
    return this.askLive(this.label);
  }

  /** Takes the frame down and releases raw mode -- used on shutdown (e.g. /exit, SIGINT). */
  release(): void {
    if (this.rawModeActive) process.stdout.write("\x1b[?7h"); // restore autowrap if mid-askLive()
    this.disableRawMode();
    this.hide();
  }

  private askLive(label: string): Promise<string> {
    process.stdout.write(`${promptDivider()}\r\n`);
    // Autowrap stays off for the whole line: redraw() below chunks label+buffer into
    // terminal-width pieces itself and joins them with explicit `\r\n`, rather than writing one
    // long string and trusting the terminal to wrap it consistently with what redraw() thinks it
    // wrote. Relying on the terminal's own wrap here is what caused the original bug (each
    // redraw's leading `\r` only returns to whatever row the terminal decided the cursor was on,
    // not the row redraw() itself is tracking) -- manual chunking keeps both in agreement no
    // matter how the buffer grows.
    process.stdout.write("\x1b[?7l");

    return new Promise<string>((resolve) => {
      let buffer = "";
      let cursor = 0;
      // How many terminal rows the input currently spans, and which of those rows (0-indexed
      // from the top) the terminal's real cursor is sitting on after the last redraw -- both are
      // needed to know how far to move before the next full repaint, since the input can grow or
      // shrink by a row as the user types or deletes.
      let inputRowCount = 1;
      let cursorRowOffset = 0;

      // Every redraw is a full repaint: move to the input's top-left, erase everything below (the
      // wrapped input rows plus the bottom divider), rewrite all of it, then reposition the cursor
      // to where it logically belongs within the buffer. More work per keystroke than a targeted
      // in-place update, but far simpler to keep correct once the input can span multiple rows and
      // the divider below it has to move with it.
      const redraw = (): void => {
        const width = process.stdout.columns || 80;
        // label may carry ANSI color codes (e.g. theme.neon("❯")), which are invisible but still
        // count toward the JS string's .length -- every column computation below has to use the
        // label's *visible* width instead, or both the wrap point and the cursor position drift
        // off by however many bytes the color codes add.
        const labelWidth = visibleLength(label);
        const availableWidth = Math.max(1, width - labelWidth);
        const indent = " ".repeat(labelWidth);

        // Continuation rows are indented to the same column the first row's text starts at
        // (right after the label), not column 0 -- a hanging indent, so wrapped text stays
        // visually aligned under where it began instead of jumping back to the left edge.
        const rows: string[] = [];
        if (buffer.length === 0) {
          rows.push(label);
        } else {
          for (let s = 0; s < buffer.length; s += availableWidth) {
            const chunk = buffer.slice(s, s + availableWidth);
            rows.push(s === 0 ? `${label}${chunk}` : `${indent}${chunk}`);
          }
        }
        inputRowCount = rows.length;

        if (cursorRowOffset > 0) process.stdout.write(`\x1b[${cursorRowOffset}A`);
        process.stdout.write("\r\x1b[0J");
        process.stdout.write(rows.join("\r\n"));
        process.stdout.write("\r\n");
        process.stdout.write(promptDivider());
        process.stdout.write("\r\n");

        let cursorRow = Math.floor(cursor / availableWidth);
        let cursorCol = labelWidth + (cursor % availableWidth);
        // The cursor sitting exactly at the end of a buffer whose length is a multiple of
        // availableWidth computes a row one past the last one actually drawn (a "deferred wrap"
        // position, since there's no more text to justify a real next row yet) -- clamp to the
        // end of the last real row instead of landing on the divider row below it.
        if (cursorRow >= inputRowCount) {
          cursorRow = inputRowCount - 1;
          cursorCol = width - 1;
        }
        const rowsToMoveUp = inputRowCount + 1 - cursorRow; // +1 for the divider row just written
        if (rowsToMoveUp > 0) process.stdout.write(`\x1b[${rowsToMoveUp}A`);
        process.stdout.write("\r");
        if (cursorCol > 0) process.stdout.write(`\x1b[${cursorCol}C`);
        cursorRowOffset = cursorRow;
      };

      // A resize mid-edit just means redraw() should recompute wrap width and row count against
      // the new terminal size -- cursorRowOffset is a plain row count fixed by our own explicit
      // `\r\n`s on the last redraw, not by column width, so it still correctly says how many rows
      // above the cursor the input's top row is regardless of what the width changed to. redraw()
      // already moves up that many rows, erases everything below, and rewrites the current buffer
      // fresh -- exactly "reformat the existing lines," no different from a normal keystroke
      // redraw except that the width it reads happens to have changed.
      const onResize = (): void => {
        redraw();
      };

      const finish = (result: string): void => {
        this.stream.off("data", onData);
        process.stdout.off("resize", onResize);
        this.disableRawMode();
        process.stdout.write("\x1b[?7h"); // restore autowrap before any normal output follows
        // Wipe the frame the line was typed into -- top divider, every input row, bottom divider
        // -- and immediately put an empty one back in its place. The typed text isn't a
        // transcript entry, so leaving the spent box behind would stack one per turn through the
        // scrollback and bury the actual conversation; but taking the box away entirely would
        // leave the screen without a prompt while the request runs. The caller echoes the
        // submitted text back in message form (formatUserMessage() in cli-theme.ts) via print(),
        // which lands it on the row the box occupied and scoots the box down one row.
        //
        // Moving up past the input rows lands on the top divider (the +1), and erase-to-end-of-
        // screen takes it and everything below. Safe for the same reason redraw()'s own `\x1b[0J`
        // is: everything below the cursor here was drawn by this frame, so there's nothing else
        // to destroy.
        process.stdout.write(`\x1b[${cursorRowOffset + 1}A`);
        process.stdout.write("\r\x1b[0J");
        this.frameVisible = false;
        this.show();
        resolve(result);
      };

      const onData = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        let i = 0;
        while (i < text.length) {
          const ch = text[i];
          if (ch === CTRL_C) {
            process.stdout.off("resize", onResize);
            process.stdout.write("\x1b[?7h");
            process.emit("SIGINT");
            return;
          }
          if (ch === "\r" || ch === "\n") {
            i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
            const rest = text.slice(i);
            if (rest.length > 0) this.queuedLines.push(...splitPastedLines(rest));
            finish(buffer);
            return;
          }
          if (ch === BACKSPACE || ch === BACKSPACE_ALT) {
            if (cursor > 0) {
              buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
              cursor--;
              redraw();
            }
            i++;
            continue;
          }
          if (ch === CTRL_A) {
            cursor = 0;
            redraw();
            i++;
            continue;
          }
          if (ch === CTRL_E) {
            cursor = buffer.length;
            redraw();
            i++;
            continue;
          }
          if (ch === CTRL_U) {
            buffer = buffer.slice(cursor);
            cursor = 0;
            redraw();
            i++;
            continue;
          }
          if (ch === "\x1b") {
            const seqLen = escapeSequenceLength(text, i);
            const seq = text.slice(i, i + seqLen);
            if (seq === ARROW_LEFT) {
              if (cursor > 0) {
                cursor--;
                redraw();
              }
            } else if (seq === ARROW_RIGHT) {
              if (cursor < buffer.length) {
                cursor++;
                redraw();
              }
            } else if (seq === DELETE_KEY) {
              if (cursor < buffer.length) {
                buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
                redraw();
              }
            }
            // Any other escape sequence (Home/End/PageUp/function keys, terminal-dependent) is
            // swallowed rather than inserted into the visible line -- seqLen reflects exactly how
            // many characters this specific sequence spans, so nothing past it gets consumed.
            i += seqLen;
            continue;
          }
          buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
          cursor++;
          redraw();
          i++;
        }
      };

      redraw(); // initial paint: label, blank buffer, and the bottom divider
      this.enableRawMode();
      this.stream.on("data", onData);
      process.stdout.on("resize", onResize);
    });
  }

  private enableRawMode(): void {
    if (this.rawModeActive) return;
    this.stream.setRawMode(true);
    this.stream.resume();
    this.rawModeActive = true;
  }

  private disableRawMode(): void {
    if (!this.rawModeActive) return;
    this.stream.setRawMode(false);
    this.stream.pause();
    this.rawModeActive = false;
  }
}

/**
 * How many terminal rows `text` takes up once printed -- its own line breaks plus however many
 * more the terminal's wrapping adds, measured in visible columns so ANSI color escapes don't
 * inflate the count. replaceLast() moves up exactly this far to land on the line's first row.
 */
function rowsOccupied(text: string): number {
  const width = process.stdout.columns || 80;
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += Math.max(1, Math.ceil(visibleLength(line) / width));
  }
  return rows;
}

function splitPastedLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * How many characters, starting at `text[start]` (an ESC), the escape sequence there actually
 * spans -- a CSI sequence (`ESC [ <param bytes 0x30-0x3F> <final byte 0x40-0x7E>`, e.g. arrow
 * keys, Delete, Home/End) or an SS3 sequence (`ESC O <letter>`, some terminals' arrow/function
 * keys in application mode) can be longer than any single recognized sequence, and guessing a
 * fixed length swallows whatever real character happens to follow a sequence this class doesn't
 * specifically recognize.
 */
function escapeSequenceLength(text: string, start: number): number {
  const introducer = text[start + 1];
  if (introducer === "[") {
    let end = start + 2;
    while (end < text.length && text[end] >= "\x30" && text[end] <= "\x3f") end++;
    if (end < text.length) end++; // final byte
    return end - start;
  }
  if (introducer === "O") {
    return Math.min(3, text.length - start);
  }
  return 1; // a lone ESC (e.g. the Escape key itself)
}
