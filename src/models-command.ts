import { createInterface, type Interface } from "node:readline/promises";
import { theme, truncateVisible } from "./cli-theme.js";
import { hasEnvVar, persistApiKey } from "./config/env.js";
import { MODEL_CATALOG, type CatalogModel, type Provider } from "./config/model-catalog.js";
import { ModelSelectionStore } from "./config/model-selection.js";
import {
  checkOllamaStatus,
  formatOllamaStatusLine,
  isModelPulled,
  pullOllamaModel,
  type OllamaStatus,
} from "./config/ollama-status.js";

export interface ModelListContext {
  enabledIds: ReadonlySet<string>;
  ollamaStatus: OllamaStatus;
  /** Env vars that currently hold a value -- passed in rather than read from process.env inside
   * this function so the rendering itself stays pure and testable. */
  configuredEnvVars: ReadonlySet<string>;
}

/** Terminal size the menu has to lay itself out inside. */
export interface MenuLayout {
  columns: number;
  rows: number;
}

function providerHeading(provider: Provider): string {
  switch (provider) {
    case "ollama":
      return "Local (Ollama)";
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "google":
      return "Google";
  }
}

function plainStatus(model: CatalogModel, ctx: ModelListContext): string {
  if (model.local) {
    return isModelPulled(model.id, ctx.ollamaStatus) ? "downloaded" : "not downloaded";
  }
  return ctx.configuredEnvVars.has(model.apiKeyEnvVar ?? "") ? "API key set" : "needs API key";
}

function colorStatus(model: CatalogModel, ctx: ModelListContext, text: string): string {
  const settled = model.local
    ? isModelPulled(model.id, ctx.ollamaStatus)
    : ctx.configuredEnvVars.has(model.apiKeyEnvVar ?? "");
  return settled ? theme.dim(text) : theme.warn(text);
}

interface ColumnWidths {
  label: number;
  id: number;
  status: number;
}

/** Name, id and status columns each pad out to the widest entry across the whole catalog (not
 * just within a provider section), so every row's columns line up the way a terminal model
 * picker's do. Computed from plain (uncolored) text, since ANSI escapes cost no columns. */
function computeColumnWidths(catalog: CatalogModel[], ctx: ModelListContext): ColumnWidths {
  return {
    label: Math.max(...catalog.map((model, i) => `${i + 1}. ${model.label}`.length)),
    id: Math.max(...catalog.map((model) => model.id.length)),
    status: Math.max(...catalog.map((model) => plainStatus(model, ctx).length)),
  };
}

/**
 * Renders one model row, clipped to `columns` so it always occupies exactly one terminal row.
 * No checkbox glyph: an enabled model's name renders in color, a disabled one dims, so the on/off
 * state reads from color contrast alone. When the full three-column form doesn't fit the width,
 * the model id (the least useful column at a glance -- it's also recorded in model-selection.json)
 * is dropped before anything else, and only then is the line hard-truncated.
 */
function renderModelRow(
  model: CatalogModel,
  index: number,
  ctx: ModelListContext,
  widths: ColumnWidths,
  isCursor: boolean,
  columns: number
): string {
  const pointer = isCursor ? theme.neon("❯") : " ";
  const status = plainStatus(model, ctx);
  const label = `${index + 1}. ${model.label}`;
  const paint = (text: string) => (ctx.enabledIds.has(model.id) ? theme.success(text) : theme.dim(text));

  // 2 for "❯ ", 2 between name and id, 3 for " · " before the status.
  const fullWidth = 2 + widths.label + 2 + widths.id + 3 + widths.status;
  const row =
    fullWidth <= columns
      ? `${pointer} ${paint(label.padEnd(widths.label))}  ${theme.dim(model.id.padEnd(widths.id))} ${theme.dim("·")} ${colorStatus(model, ctx, status)}`
      : `${pointer} ${paint(label.padEnd(widths.label))} ${theme.dim("·")} ${colorStatus(model, ctx, status)}`;

  return truncateVisible(row, columns);
}

/**
 * Renders the toggleable model list as one string -- one section per provider, in MODEL_CATALOG's
 * own order (Ollama first, so local/free options are visible before any provider that needs a
 * paid API key). Used by the non-TTY numbered fallback, which just prints and has no width or
 * height budget to respect; the interactive menu uses renderMenuLines() instead.
 */
export function renderModelList(catalog: CatalogModel[], ctx: ModelListContext, cursorIndex = -1): string {
  const widths = computeColumnWidths(catalog, ctx);
  const lines: string[] = [];
  let currentProvider: Provider | null = null;

  catalog.forEach((model, index) => {
    if (model.provider !== currentProvider) {
      currentProvider = model.provider;
      lines.push("", theme.bold(providerHeading(model.provider)));
    }
    lines.push(renderModelRow(model, index, ctx, widths, index === cursorIndex, Number.MAX_SAFE_INTEGER));
  });

  return lines.join("\n");
}

/** Below this many terminal rows, the header/footer trim down to bare essentials and the list
 * drops its per-provider headings and blank separators -- in a short pane those cost rows the
 * models themselves need, and the menu has to fit on screen in full (see renderMenuLines). */
const COMPACT_ROWS_THRESHOLD = 16;

function chooseWindowStart(total: number, cursor: number, count: number): number {
  if (count >= total) return 0;
  const centered = cursor - Math.floor(count / 2);
  return Math.max(0, Math.min(centered, total - count));
}

function buildListLines(
  catalog: CatalogModel[],
  ctx: ModelListContext,
  cursorIndex: number,
  widths: ColumnWidths,
  start: number,
  count: number,
  columns: number,
  withHeadings: boolean
): string[] {
  const lines: string[] = [];
  if (start > 0) lines.push(theme.dim(`  ↑ ${start} more`));

  let currentProvider: Provider | null = null;
  let emittedRow = false;
  for (let index = start; index < Math.min(start + count, catalog.length); index++) {
    const model = catalog[index];
    if (withHeadings && model.provider !== currentProvider) {
      currentProvider = model.provider;
      // Blank separator only between sections -- never directly under a "↑ n more" marker, where
      // it would cost a row without separating anything.
      if (emittedRow) lines.push("");
      lines.push(theme.bold(truncateVisible(providerHeading(model.provider), columns)));
    }
    lines.push(renderModelRow(model, index, ctx, widths, index === cursorIndex, columns));
    emittedRow = true;
  }

  const below = catalog.length - (start + count);
  if (below > 0) lines.push(theme.dim(`  ↓ ${below} more`));
  return lines;
}

/**
 * Lays the whole menu out as an array of terminal lines, with two invariants the interactive
 * redraw depends on absolutely:
 *
 *   1. every line fits within `layout.columns` visible columns, so no line ever wraps onto a
 *      second terminal row, and
 *   2. the returned line count never exceeds `layout.rows`, so the whole menu is on screen at
 *      once and a "move the cursor up this many lines" redraw always lands back on its own first
 *      line instead of somewhere in the middle of it.
 *
 * Violating either one is what made the previous redraw-in-place version drift and leave
 * duplicated, interleaved copies of the list behind: it counted newlines while the terminal was
 * counting (wrapped, sometimes scrolled) rows. Both invariants are covered by tests. When the
 * catalog doesn't fit the height, the list becomes a window around the cursor with "↑ n more" /
 * "↓ n more" markers rather than being allowed to overflow.
 */
export function renderMenuLines(
  catalog: CatalogModel[],
  ctx: ModelListContext,
  cursorIndex: number,
  layout: MenuLayout
): string[] {
  const columns = Math.max(20, layout.columns);
  const widths = computeColumnWidths(catalog, ctx);
  const compact = layout.rows < COMPACT_ROWS_THRESHOLD;

  const head = compact
    ? [theme.bold("Select models"), truncateVisible(formatOllamaStatusLine(ctx.ollamaStatus), columns)]
    : [
        theme.neon("─".repeat(columns)),
        theme.bold("Select models"),
        theme.dim(truncateVisible("Nothing is enabled until you turn it on. Enabled models show in green.", columns)),
        "",
        truncateVisible(formatOllamaStatusLine(ctx.ollamaStatus), columns),
        "",
      ];
  const foot = compact
    ? [theme.dim(truncateVisible("↑/↓ move · enter toggle · esc done", columns))]
    : ["", theme.dim(truncateVisible("↑/↓ navigate  ·  enter toggle  ·  esc done", columns))];

  const listBudget = layout.rows - head.length - foot.length;
  // Nothing sensible fits: give the cursor's own row and nothing else, so the menu is still
  // usable (and still exactly as tall as it claims) in a pane only a few rows high.
  if (listBudget < 3) {
    const cursorRow = renderModelRow(catalog[cursorIndex], cursorIndex, ctx, widths, true, columns);
    return [...head, ...(listBudget > 0 ? [cursorRow] : []), ...foot].slice(0, Math.max(1, layout.rows));
  }

  // Headings and "↑/↓ n more" markers take rows too, and how many depends on which slice is
  // visible, so shrink the window until what actually got rendered fits the budget.
  let count = Math.min(catalog.length, listBudget);
  let listLines: string[] = [];
  for (;;) {
    const start = chooseWindowStart(catalog.length, cursorIndex, count);
    listLines = buildListLines(catalog, ctx, cursorIndex, widths, start, count, columns, !compact);
    if (listLines.length <= listBudget || count <= 1) break;
    count--;
  }

  return [...head, ...listLines.slice(0, listBudget), ...foot];
}

type PrepareResult = "ready" | "pulled" | "declined" | "unavailable";

/**
 * Runs whatever setup a model needs before it can be toggled on: for a local model, confirms
 * Ollama is installed and running and offers to `ollama pull` it if it isn't downloaded yet; for
 * an API-key-based model, prompts for and persists the key if one isn't already configured.
 * Returns "declined"/"unavailable" (rather than throwing) when the model should stay off --
 * the caller treats both as "don't toggle it on" without needing to know why. Always runs
 * through a plain (non-raw) readline `Interface` the caller owns for the duration of the prompt,
 * so the arrow-key menu's raw-mode listener has to be torn down and rebuilt around this rather
 * than trying to run alongside it -- see toggleCurrent in runInteractiveMenu.
 */
async function prepareModelForUse(model: CatalogModel, ollamaStatus: OllamaStatus, rl: Interface, dotEnvPath: string): Promise<PrepareResult> {
  if (model.local) {
    if (!ollamaStatus.installed) {
      console.log(theme.error("Ollama isn't installed -- install it from https://ollama.com/download, then try again."));
      return "unavailable";
    }
    if (!ollamaStatus.running) {
      console.log(theme.error("Ollama isn't running -- start it with `ollama serve` (or open the Ollama app), then try again."));
      return "unavailable";
    }
    if (isModelPulled(model.id, ollamaStatus)) {
      return "ready";
    }
    const answer = await rl.question(
      `${model.label} isn't downloaded yet. Download it now with \`ollama pull ${model.id}\`? [y/N] `
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      return "declined";
    }
    console.log(theme.dim(`Downloading ${model.id} -- this can take a while for larger models...`));
    try {
      await pullOllamaModel(model.id, (line) => console.log(theme.dim(line)));
      return "pulled";
    } catch (err) {
      console.log(theme.error(`Download failed: ${err instanceof Error ? err.message : String(err)}`));
      return "unavailable";
    }
  }

  if (!model.apiKeyEnvVar || hasEnvVar(model.apiKeyEnvVar)) {
    return "ready";
  }

  console.log(theme.dim(`${model.label} needs ${model.apiKeyEnvVar} to be set.`));
  const key = (await rl.question(`Enter ${model.apiKeyEnvVar}: `)).trim();
  if (!key) {
    console.log(theme.warn("No key entered -- leaving this model disabled."));
    return "declined";
  }
  persistApiKey(model.apiKeyEnvVar, key, dotEnvPath);
  console.log(theme.success(`Saved ${model.apiKeyEnvVar} to .env.`));
  return "ready";
}

function configuredEnvVarsSet(): Set<string> {
  return new Set(MODEL_CATALOG.flatMap((m) => (m.apiKeyEnvVar && hasEnvVar(m.apiKeyEnvVar) ? [m.apiKeyEnvVar] : [])));
}

function printFinalSelection(store: ModelSelectionStore): void {
  const enabled = store.list();
  console.log(
    enabled.length > 0
      ? theme.success(`${enabled.length} model(s) enabled: ${enabled.join(", ")}\n`)
      : theme.warn("No models enabled -- nothing will be available to route to.\n")
  );
}

export interface ModelsCommandOptions {
  /** Where enabled-model state persists across CLI sessions. */
  selectionPath: string;
  /** Where a newly entered API key gets written. */
  dotEnvPath: string;
}

/**
 * Interactive /models command: an arrow-key menu (↑/↓ to move, Enter to toggle the highlighted
 * model, Esc to finish) when both stdin and stdout are a real TTY, falling back to a plain
 * type-a-number-and-press-enter loop otherwise (piped input, or a non-interactive test harness --
 * same fallback rationale as FramedPrompt's isFullyInteractive check in cli.ts). Ollama's status
 * is checked up front (see checkOllamaStatus) so local models' downloaded state is accurate from
 * the first render. Toggling a model on runs whatever setup it needs (API key prompt, or an
 * Ollama download prompt) before it actually gets enabled; declining that setup leaves it off.
 * For Ollama entries, cli.ts reads this same selection file on every subtask to decide which
 * local-model bandit arms exist -- so toggling one on here takes effect on the very next request,
 * no restart needed. (OpenAI/Google entries still have no execution wiring -- see model-catalog.ts.)
 */
export async function runModelsCommand(options: ModelsCommandOptions): Promise<void> {
  const store = ModelSelectionStore.load(options.selectionPath);
  const ollamaStatus = await checkOllamaStatus();

  if (process.stdin.isTTY && process.stdout.isTTY) {
    await runInteractiveMenu(store, ollamaStatus, options.dotEnvPath);
  } else {
    await runNumberedFallback(store, ollamaStatus, options.dotEnvPath);
  }

  printFinalSelection(store);
}

/**
 * Raw-keystroke arrow menu, redrawn in place on every keypress. Owns two pieces of terminal state
 * for its lifetime, both restored on every exit path (Esc, Ctrl+C, a thrown error, and around the
 * setup prompts below):
 *
 *   - stdin's raw mode, so arrow keys arrive as keystrokes instead of buffered lines. cli.ts's own
 *     FramedPrompt has already released raw mode by the time `/models` is dispatched (it always
 *     does so before ask() resolves), so there's nothing to coordinate with on entry.
 *   - the terminal's autowrap (turned off via `\x1b[?7l`, same as FramedPrompt does for its own
 *     redraws). With autowrap on, one over-wide line silently becomes two terminal rows and the
 *     redraw's "up N lines" no longer matches what's on screen -- that mismatch is what left
 *     duplicated, interleaved copies of the list behind. renderMenuLines() clips every line to the
 *     width as well, so this is belt and braces: neither wrapping nor overflow can happen.
 */
async function runInteractiveMenu(store: ModelSelectionStore, initialOllamaStatus: OllamaStatus, dotEnvPath: string): Promise<void> {
  const stream = process.stdin;
  let ollamaStatus = initialOllamaStatus;
  let cursor = 0;
  let linesPrinted = 0;

  const listContext = (): ModelListContext => ({
    enabledIds: new Set(store.list()),
    ollamaStatus,
    configuredEnvVars: configuredEnvVarsSet(),
  });

  const erase = (): void => {
    if (linesPrinted === 0) return;
    // Every printed line ends in "\n", so the cursor sits at column 0 of the row just past the
    // last one -- moving up exactly linesPrinted rows lands on the menu's own first line, and
    // erasing to end of screen from there clears precisely what was drawn and nothing above it.
    process.stdout.write(`\x1b[${linesPrinted}A\r\x1b[0J`);
    linesPrinted = 0;
  };

  const render = (): void => {
    erase();
    const lines = renderMenuLines(MODEL_CATALOG, listContext(), cursor, {
      columns: process.stdout.columns || 80,
      // One row short of the terminal's height on purpose: the write below ends in a newline, so
      // a menu exactly as tall as the screen would scroll it by one row every redraw -- pushing
      // its own first line into the scrollback and out of reach of the next erase().
      rows: Math.max(4, (process.stdout.rows || 24) - 1),
    });
    process.stdout.write(`${lines.join("\n")}\n`);
    linesPrinted = lines.length;
  };

  const setRawMode = (on: boolean): void => {
    stream.setRawMode(on);
    if (on) stream.resume();
    else stream.pause();
  };
  const setAutowrap = (on: boolean): void => {
    process.stdout.write(on ? "\x1b[?7h" : "\x1b[?7l");
  };

  try {
    setAutowrap(false);
    await new Promise<void>((resolve) => {
      let finished = false;

      const finish = (): void => {
        if (finished) return;
        finished = true;
        stream.off("data", onData);
        process.stdout.off("resize", onResize);
        setRawMode(false);
        // Leave the menu's last state on screen and put the cursor below it.
        process.stdout.write("\n");
        resolve();
      };

      // A resize changes both the width every line is clipped to and how many rows fit, so the
      // menu has to be laid out again -- erase() still holds a valid line count here because
      // no line was ever allowed to wrap.
      const onResize = (): void => {
        render();
      };

      /**
       * Toggling on a model that needs setup can't happen while we own raw mode and autowrap:
       * prepareModelForUse prompts via a plain readline `Interface`, which needs normal cooked
       * line editing (and wrapping, for a long pasted API key). So this hands the terminal fully
       * back for the duration of the prompt -- erasing the menu first so the prompt isn't printed
       * underneath a stale copy of it -- then takes it back and redraws.
       */
      const toggleCurrent = async (): Promise<void> => {
        const model = MODEL_CATALOG[cursor];
        if (store.isEnabled(model.id)) {
          store.toggle(model.id);
          render();
          return;
        }

        stream.off("data", onData);
        erase();
        setRawMode(false);
        setAutowrap(true);
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        let result: PrepareResult;
        try {
          result = await prepareModelForUse(model, ollamaStatus, rl, dotEnvPath);
        } finally {
          rl.close();
        }
        if (result === "pulled") {
          ollamaStatus = await checkOllamaStatus();
        }
        if (result === "ready" || result === "pulled") {
          store.toggle(model.id);
        }

        setAutowrap(false);
        setRawMode(true);
        stream.on("data", onData);
        render();
      };

      const onData = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        if (text === "\x03") {
          // Ctrl+C: match FramedPrompt's handling -- give the terminal back cleanly, then let
          // cli.ts's own SIGINT handler do the actual exit.
          finish();
          setAutowrap(true);
          process.emit("SIGINT");
          return;
        }
        if (text === "\x1b") {
          finish();
          return;
        }
        if (text === "\x1b[A") {
          cursor = (cursor - 1 + MODEL_CATALOG.length) % MODEL_CATALOG.length;
          render();
          return;
        }
        if (text === "\x1b[B") {
          cursor = (cursor + 1) % MODEL_CATALOG.length;
          render();
          return;
        }
        if (text === "\r" || text === "\n") {
          void toggleCurrent();
        }
      };

      render();
      setRawMode(true);
      stream.on("data", onData);
      process.stdout.on("resize", onResize);
    });
  } finally {
    setAutowrap(true);
  }
}

/**
 * Type-a-number-and-press-enter loop for when stdin/stdout isn't a real TTY (piped input,
 * automated tests) -- setRawMode() doesn't exist on a non-TTY stream, so the arrow-key menu can't
 * run at all there.
 */
async function runNumberedFallback(store: ModelSelectionStore, initialOllamaStatus: OllamaStatus, dotEnvPath: string): Promise<void> {
  let ollamaStatus = initialOllamaStatus;
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log(`\n${formatOllamaStatusLine(ollamaStatus)}`);

    for (;;) {
      console.log(renderModelList(MODEL_CATALOG, { enabledIds: new Set(store.list()), ollamaStatus, configuredEnvVars: configuredEnvVarsSet() }));
      console.log(theme.dim("\nEnter a number to toggle a model, or press Enter to finish."));

      const answer = (await rl.question(`${theme.neon("❯")} `)).trim();
      if (!answer) break;

      const index = Number(answer);
      const model = Number.isInteger(index) ? MODEL_CATALOG[index - 1] : undefined;
      if (!model) {
        console.log(theme.error(`Not a valid choice: ${answer}`));
        continue;
      }

      if (store.isEnabled(model.id)) {
        store.toggle(model.id);
        console.log(theme.dim(`Disabled ${model.label}.\n`));
        continue;
      }

      const result = await prepareModelForUse(model, ollamaStatus, rl, dotEnvPath);
      if (result === "pulled") {
        ollamaStatus = await checkOllamaStatus();
      }
      if (result === "ready" || result === "pulled") {
        store.toggle(model.id);
        console.log(theme.success(`Enabled ${model.label}.\n`));
      } else {
        console.log();
      }
    }
  } finally {
    rl.close();
  }
}
