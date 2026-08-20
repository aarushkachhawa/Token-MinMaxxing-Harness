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
 * Renders a rounded box: a gradient title, a dim subtitle, a blank separator, then one line per
 * entry in `rows` (rows may already contain color codes -- width is measured with them stripped).
 * Width auto-sizes to the widest visible line, capped to the terminal width so it never wraps.
 */
export function drawBanner(title: string, subtitle: string, rows: string[]): string {
  const maxWidth = Math.max((process.stdout.columns ?? 80) - 4, 20);
  const contentLines = [gradient(title), theme.dim(subtitle), "", ...rows];
  const innerWidth = Math.min(Math.max(...contentLines.map(visibleLength)), maxWidth);

  const border = theme.neon;
  const top = border(`╭${"─".repeat(innerWidth + 2)}╮`);
  const bottom = border(`╰${"─".repeat(innerWidth + 2)}╯`);
  const line = (text: string) => {
    const pad = Math.max(0, innerWidth - visibleLength(text));
    return `${border("│")} ${text}${" ".repeat(pad)} ${border("│")}`;
  };

  return [top, ...contentLines.map(line), bottom].join("\n");
}

const RESPONSE_MAX_WIDTH = 92;
const RESPONSE_INDENT = "  ";

/**
 * Formats a finished request's answer for display: a small labeled header so a response is
 * visually distinguishable from the step log above it, then the text itself word-wrapped to a
 * comfortable reading column (not the full terminal width, which looks cluttered and hurts
 * readability on a wide terminal) and indented so it reads as a block distinct from the
 * flush-left prompt/step lines around it. Purely a display transform -- callers should keep using
 * the original unwrapped text for anything besides printing (conversation history, summarization).
 */
export function formatResponse(text: string): string {
  const width = Math.max(Math.min((process.stdout.columns || 80) - RESPONSE_INDENT.length, RESPONSE_MAX_WIDTH), 20);
  const header = `${theme.neon("✦")} ${theme.bold("Harness")}`;
  const body = text
    .split("\n")
    .flatMap((paragraph) => wrapWords(paragraph, width))
    .map((line) => `${RESPONSE_INDENT}${line}`)
    .join("\n");
  return `${header}\n${body}`;
}

function wrapWords(paragraph: string, width: number): string[] {
  if (paragraph.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of paragraph.split(" ")) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
