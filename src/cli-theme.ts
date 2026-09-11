/**
 * Neon-blue ANSI theme for the interactive CLI (src/cli.ts) and its progress UI
 * (src/progress-ui.ts). Truecolor escape codes only -- no dependency, matching the rest of this
 * project's zero-frills approach to terminal output. Color is skipped entirely when stdout isn't a
 * TTY (piped/redirected output) or NO_COLOR is set (https://no-color.org), same convention
 * ProgressUI already follows for its own interactivity check.
 */
const colorEnabled = Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env);

function paint(code: string, text: string): string {
  return colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const theme = {
  neon: (text: string) => paint("38;2;0;217;255", text), // neon cyan-blue -- primary accent
  electric: (text: string) => paint("38;2;56;130;246", text), // electric blue -- secondary accent
  violet: (text: string) => paint("38;2;167;92;255", text), // violet -- highlight
  dim: (text: string) => paint("2", text),
  bold: (text: string) => paint("1", text),
  success: (text: string) => paint("38;2;0;255;170", text),
  warn: (text: string) => paint("38;2;255;191;0", text),
  error: (text: string) => paint("38;2;255;92;92", text),
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Length of `text` with color escape codes stripped, for padding/centering math. */
export function visibleLength(text: string): number {
  return text.replace(ANSI_RE, "").length;
}

/**
 * Cuts `text` down to at most `maxVisible` *visible* columns, leaving ANSI color escapes intact
 * (they cost no columns) and closing with a reset if anything was dropped mid-color. Needed
 * wherever a line has to be guaranteed to fit the terminal's width -- a redraw-in-place UI that
 * lets even one line wrap onto a second terminal row silently invalidates its own
 * "move up N lines" math, since N counts newlines and the terminal counts rows.
 */
export function truncateVisible(text: string, maxVisible: number): string {
  if (maxVisible <= 0) return "";
  if (visibleLength(text) <= maxVisible) return text;

  let out = "";
  let visible = 0;
  let sawEscape = false;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\x1b") {
      const end = text.indexOf("m", i);
      if (end === -1) break;
      out += text.slice(i, end + 1);
      sawEscape = true;
      i = end + 1;
      continue;
    }
    // Step by code point so a multi-byte character (e.g. an emoji) is never split in half.
    const codePoint = String.fromCodePoint(text.codePointAt(i) as number);
    if (visible + 1 > maxVisible) break;
    out += codePoint;
    visible += 1;
    i += codePoint.length;
  }
  return sawEscape ? `${out}\x1b[0m` : out;
}

/** Renders `text` with each non-space character interpolated between two neon-blue tones. */
export function gradient(text: string): string {
  if (!colorEnabled) return text;
  const from: [number, number, number] = [0, 217, 255];
  const to: [number, number, number] = [167, 92, 255];
  const chars = [...text];
  const painted = chars
    .map((ch, i) => {
      if (ch === " ") return ch;
      const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
      const r = Math.round(from[0] + (to[0] - from[0]) * t);
      const g = Math.round(from[1] + (to[1] - from[1]) * t);
      const b = Math.round(from[2] + (to[2] - from[2]) * t);
      return `\x1b[38;2;${r};${g};${b}m${ch}`;
    })
    .join("");
  return `${painted}\x1b[0m`;
}

/**
 * A full-width horizontal rule framing the input prompt in src/cli.ts: one printed before
 * rl.question() and one after, with nothing but a plain `❯ ` prompt (no side borders) between
 * them. There's deliberately no boxed/vertical-bordered version -- a dynamic right-hand border
 * around the typed text itself would need full terminal-cell control (an Ink-style TUI), and side
 * borders around a single unbounded input line added visual noise without adding structure.
 */
export function dividerWidth(): number {
  // `||` only falls back on null/undefined/0, not a real width -- a terminal that hasn't reported
  // a size yet can legitimately read `columns: 0`, which `.repeat(0)` would silently turn into an
  // empty line.
  //
  // One column short of the terminal, never the full width. Writing the last column of a row
  // leaves the cursor in a state terminals disagree about: most hold it there until another
  // character arrives, but some advance to the next row immediately. On those, a full-width
  // divider silently cost an extra row, which stranded the cursor a row below where the frame
  // thought it was and left a divider behind on every repaint. Stopping one short means no line
  // the frame draws can ever trigger a wrap, so the geometry is the same on both kinds.
  return Math.max(1, (process.stdout.columns || 80) - 1);
}

export function promptDivider(): string {
  return theme.neon("─".repeat(dividerWidth()));
}

/**
 * Renders the startup banner: a full-width top rule (matching promptDivider()'s style), then a
 * gradient title, a dim subtitle, a blank separator, and one line per entry in `rows` -- all
 * flush left, no side borders or bottom rule. A boxed version was tried first, but a bordered
 * box around left-aligned text needs a right-hand border to look intentional, and a side border
 * around a variable-width terminal adds visual noise without adding structure -- same reasoning
 * that ruled out a boxed version of the input prompt (see promptDivider() above).
 */
export function drawBanner(title: string, subtitle: string, rows: string[]): string {
  return [promptDivider(), gradient(title), theme.dim(subtitle), "", ...rows].join("\n");
}

const RESPONSE_MAX_WIDTH = 92;
const RESPONSE_INDENT = "  ";

/**
 * Shared layout for one message in the transcript, whoever sent it: a marker sits right next to
 * the first line (so the message is visually distinguishable from the status line above it
 * without a separate header row), the text is word-wrapped to a comfortable reading column (not
 * the full terminal width, which looks cluttered and hurts readability on a wide terminal), and
 * every line after the first -- both wrapped continuations and separate paragraphs -- gets a
 * hanging indent matching the marker's visible width, so the whole block reads as aligned under
 * the marker rather than the marker looking like a bullet on an otherwise flush-left paragraph.
 * Purely a display transform -- callers should keep using the original unwrapped text for
 * anything besides printing (conversation history, summarization).
 */
function formatMarkedBlock(
  text: string,
  marker: string,
  options: { renderBold: boolean; paint: (line: string) => string }
): string {
  const width = Math.max(Math.min((process.stdout.columns || 80) - RESPONSE_INDENT.length, RESPONSE_MAX_WIDTH), 20);
  const lines = text.split("\n").flatMap((paragraph) => wrapWords(paragraph, width, options.renderBold));
  return lines.map((line, i) => `${i === 0 ? marker : RESPONSE_INDENT}${options.paint(line)}`).join("\n");
}

/**
 * Formats a finished request's answer: a neon star marker, and any `**markdown bold**` the model
 * wrote rendered as real terminal bold instead of showing the literal asterisks.
 */
export function formatResponse(text: string): string {
  return formatMarkedBlock(text, `${theme.neon("✦")} `, { renderBold: true, paint: (line) => line });
}

/**
 * Formats a request the user just typed, for echoing into the transcript once its input frame has
 * been erased (see FramedPrompt) -- so a scrolled-back conversation reads as alternating messages
 * rather than a stack of leftover input boxes. Deliberately the same shape as formatResponse()
 * with two differences: a violet `❯` rather than a neon `✦`, and dimmed text, so past turns
 * recede behind the answer they produced instead of competing with it. Bold markup is *not*
 * interpreted here -- this is the user's literal text, so a typed `**` should stay on screen as
 * the two characters they actually typed.
 */
export function formatUserMessage(text: string): string {
  return formatMarkedBlock(text, `${theme.violet("❯")} `, { renderBold: false, paint: theme.dim });
}

interface Word {
  text: string;
  bold: boolean;
}

/**
 * Splits a paragraph into words, tagging each with whether it fell inside a `**...**` span --
 * per-word rather than per-line, so a bold span that happens to straddle a wrap boundary (a
 * multi-word `**like this one**`) still renders correctly on both resulting lines instead of
 * leaving an unpaired `**` marker on one of them. With `renderBold` false the markup isn't
 * recognized at all and every `**` stays in the text verbatim.
 */
function tokenizeBold(paragraph: string, renderBold: boolean): Word[] {
  const words: Word[] = [];
  const pushPlain = (segment: string, bold: boolean) => {
    for (const w of segment.split(" ")) if (w.length > 0) words.push({ text: w, bold });
  };
  if (!renderBold) {
    pushPlain(paragraph, false);
    return words;
  }
  const boldSpan = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  for (const match of paragraph.matchAll(boldSpan)) {
    pushPlain(paragraph.slice(lastIndex, match.index), false);
    pushPlain(match[1], true);
    lastIndex = match.index + match[0].length;
  }
  pushPlain(paragraph.slice(lastIndex), false);
  return words;
}

function wrapWords(paragraph: string, width: number, renderBold: boolean): string[] {
  const words = tokenizeBold(paragraph, renderBold);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current: Word[] = [];
  let currentLength = 0;
  for (const word of words) {
    const extra = (current.length === 0 ? 0 : 1) + word.text.length;
    if (currentLength + extra > width && current.length > 0) {
      lines.push(renderWords(current));
      current = [word];
      currentLength = word.text.length;
    } else {
      current.push(word);
      currentLength += extra;
    }
  }
  if (current.length > 0) lines.push(renderWords(current));
  return lines;
}

function renderWords(words: Word[]): string {
  return words.map((w) => (w.bold ? theme.bold(w.text) : w.text)).join(" ");
}

/**
 * Clears the terminal so the CLI opens on an empty screen rather than under whatever was already
 * scrolled up there. Wipes the scrollback buffer too (`\x1b[3J`), not just the visible rows, so
 * scrolling up after launch doesn't reveal the previous session -- `clear` on its own leaves that
 * behind on most terminals. Skipped entirely when stdout isn't a TTY, where the escape codes
 * would just be literal garbage in a captured log.
 */
export function clearScreen(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}
