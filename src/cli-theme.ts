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
export function promptDivider(): string {
  // `??` only falls back on null/undefined, not 0 -- a terminal that hasn't reported a size yet
  // can legitimately read `columns: 0`, which `.repeat(0)` would silently turn into an empty line.
  return theme.neon("─".repeat(process.stdout.columns || 80));
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
 * Formats a finished request's answer for display: a neon star sits right next to the first line
 * of the response (so it's visually distinguishable from the step log above it without a
 * separate header line), the text is word-wrapped to a comfortable reading column (not the full
 * terminal width, which looks cluttered and hurts readability on a wide terminal), and any
 * `**markdown bold**` the model wrote renders as real terminal bold instead of showing the
 * literal asterisks. Every line after the first -- both wrapped continuations and separate
 * paragraphs -- gets a hanging indent matching the star's visible width, so the whole block reads
 * as aligned under the star rather than the star looking like a bullet on an otherwise flush-left
 * paragraph. Purely a display transform -- callers should keep using the original unwrapped text
 * for anything besides printing (conversation history, summarization).
 */
export function formatResponse(text: string): string {
  const marker = `${theme.neon("✦")} `;
  const width = Math.max(Math.min((process.stdout.columns || 80) - RESPONSE_INDENT.length, RESPONSE_MAX_WIDTH), 20);
  const lines = text.split("\n").flatMap((paragraph) => wrapWords(paragraph, width));
  return lines.map((line, i) => `${i === 0 ? marker : RESPONSE_INDENT}${line}`).join("\n");
}

interface Word {
  text: string;
  bold: boolean;
}

/**
 * Splits a paragraph into words, tagging each with whether it fell inside a `**...**` span --
 * per-word rather than per-line, so a bold span that happens to straddle a wrap boundary (a
 * multi-word `**like this one**`) still renders correctly on both resulting lines instead of
 * leaving an unpaired `**` marker on one of them.
 */
function tokenizeBold(paragraph: string): Word[] {
  const words: Word[] = [];
  const pushPlain = (segment: string, bold: boolean) => {
    for (const w of segment.split(" ")) if (w.length > 0) words.push({ text: w, bold });
  };
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

function wrapWords(paragraph: string, width: number): string[] {
  const words = tokenizeBold(paragraph);
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
