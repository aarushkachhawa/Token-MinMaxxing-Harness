import { afterEach, describe, expect, it, vi } from "vitest";
import { theme, visibleLength } from "./cli-theme.js";
import { MODEL_CATALOG } from "./config/model-catalog.js";
import type { OllamaStatus } from "./config/ollama-status.js";
import { renderMenuLines, renderModelList } from "./models-command.js";

const emptyOllamaStatus: OllamaStatus = { installed: true, running: true, localModels: [] };

/** Every real model row carries an id/status column joined by this separator; header, blank, and
 * provider-heading lines never do, so it's a reliable way to pick out just the model rows. */
function modelRows(output: string): string[] {
  return output.split("\n").filter((l) => l.includes(" · "));
}

describe("renderModelList", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists every catalog model with a heading per provider", () => {
    const output = renderModelList(MODEL_CATALOG, {
      enabledIds: new Set(),
      ollamaStatus: emptyOllamaStatus,
      configuredEnvVars: new Set(),
    });

    expect(output).toContain("Local (Ollama)");
    expect(output).toContain("Anthropic");
    expect(output).toContain("OpenAI");
    expect(output).toContain("Google");
    for (const model of MODEL_CATALOG) {
      expect(output).toContain(model.label);
      expect(output).toContain(model.id);
    }
  });

  it("has no checkbox glyph -- enabled state is color-only", () => {
    const output = renderModelList(MODEL_CATALOG, {
      enabledIds: new Set(["claude-sonnet-5"]),
      ollamaStatus: emptyOllamaStatus,
      configuredEnvVars: new Set(),
    });

    expect(output).not.toContain("[x]");
    expect(output).not.toContain("[ ]");
  });

  it("renders an enabled model's label through theme.success and a disabled one through theme.dim", () => {
    vi.spyOn(theme, "success").mockImplementation((text) => `<success>${text}</success>`);
    vi.spyOn(theme, "dim").mockImplementation((text) => `<dim>${text}</dim>`);

    const output = renderModelList(MODEL_CATALOG, {
      enabledIds: new Set(["claude-sonnet-5"]),
      ollamaStatus: emptyOllamaStatus,
      configuredEnvVars: new Set(),
    });

    const sonnetIndex = MODEL_CATALOG.findIndex((m) => m.label === "Claude Sonnet 5") + 1;
    const haikuIndex = MODEL_CATALOG.findIndex((m) => m.label === "Claude Haiku 4.5") + 1;
    const enabledLine = output.split("\n").find((l) => l.includes("Claude Sonnet 5"));
    const disabledLine = output.split("\n").find((l) => l.includes("Claude Haiku 4.5"));
    expect(enabledLine).toContain(`<success>${sonnetIndex}. Claude Sonnet 5`);
    expect(disabledLine).toContain(`<dim>${haikuIndex}. Claude Haiku 4.5`);
  });

  it("marks a cloud model needing an API key vs one that already has it configured", () => {
    const output = renderModelList(MODEL_CATALOG, {
      enabledIds: new Set(),
      ollamaStatus: emptyOllamaStatus,
      configuredEnvVars: new Set(["ANTHROPIC_API_KEY"]),
    });

    const anthropicLine = output.split("\n").find((l) => l.includes("Claude Sonnet 5"));
    const openaiLine = output.split("\n").find((l) => l.includes("GPT-4o mini"));
    expect(anthropicLine).toContain("API key set");
    expect(openaiLine).toContain("needs API key");
  });

  it("marks the row at cursorIndex with a pointer and leaves others without one", () => {
    const withCursor = renderModelList(
      MODEL_CATALOG,
      { enabledIds: new Set(), ollamaStatus: emptyOllamaStatus, configuredEnvVars: new Set() },
      1
    );
    const rows = modelRows(withCursor);
    expect(rows[1]).toContain("❯");
    expect(rows[0]).not.toContain("❯");
  });

  it("marks a local model downloaded vs not downloaded based on ollamaStatus", () => {
    const output = renderModelList(MODEL_CATALOG, {
      enabledIds: new Set(),
      ollamaStatus: { installed: true, running: true, localModels: ["llama3.1:8b"] },
      configuredEnvVars: new Set(),
    });

    const pulled = output.split("\n").find((l) => l.includes("Llama 3.1 8B"));
    const notPulled = output.split("\n").find((l) => l.includes("Qwen2.5 Coder 7B"));
    expect(pulled).not.toContain("not downloaded");
    expect(pulled).toContain("downloaded");
    expect(notPulled).toContain("not downloaded");
  });

  it("keeps the id column for the fallback's unconstrained rendering", () => {
    const output = renderModelList(MODEL_CATALOG, {
      enabledIds: new Set(),
      ollamaStatus: emptyOllamaStatus,
      configuredEnvVars: new Set(),
    });
    for (const model of MODEL_CATALOG) {
      expect(output).toContain(model.id);
    }
  });

  it("aligns every row's id/status column at the same offset", () => {
    const output = renderModelList(MODEL_CATALOG, {
      enabledIds: new Set(),
      ollamaStatus: emptyOllamaStatus,
      configuredEnvVars: new Set(),
    });

    const columnOffsets = new Set(modelRows(output).map((l) => l.indexOf(" · ")));
    expect(columnOffsets.size).toBe(1);
  });
});

/**
 * These two invariants are the whole reason the interactive menu can redraw itself in place: a
 * line that wraps, or a menu taller than the screen, silently breaks the "move up N lines" math
 * and leaves duplicated, interleaved copies of the list on screen (which is exactly what the
 * earlier version did). They're asserted across a spread of realistic and hostile terminal sizes.
 */
describe("renderMenuLines", () => {
  const ctx = {
    enabledIds: new Set(["claude-sonnet-5"]),
    ollamaStatus: { installed: true, running: true, localModels: ["llama3.1:8b"] } as OllamaStatus,
    configuredEnvVars: new Set(["ANTHROPIC_API_KEY"]),
  };

  const sizes = [
    { columns: 200, rows: 60 },
    { columns: 120, rows: 40 },
    { columns: 100, rows: 24 },
    { columns: 80, rows: 24 },
    { columns: 60, rows: 20 },
    { columns: 40, rows: 12 },
    { columns: 24, rows: 8 },
  ];

  for (const layout of sizes) {
    it(`fits every line within ${layout.columns} columns`, () => {
      for (let cursor = 0; cursor < MODEL_CATALOG.length; cursor++) {
        for (const line of renderMenuLines(MODEL_CATALOG, ctx, cursor, layout)) {
          expect(visibleLength(line)).toBeLessThanOrEqual(layout.columns);
        }
      }
    });

    it(`fits the whole menu within ${layout.rows} rows`, () => {
      for (let cursor = 0; cursor < MODEL_CATALOG.length; cursor++) {
        expect(renderMenuLines(MODEL_CATALOG, ctx, cursor, layout).length).toBeLessThanOrEqual(layout.rows);
      }
    });
  }

  it("always keeps the cursor's own row visible, even in a short window", () => {
    for (let cursor = 0; cursor < MODEL_CATALOG.length; cursor++) {
      const lines = renderMenuLines(MODEL_CATALOG, ctx, cursor, { columns: 100, rows: 14 });
      const cursorRow = lines.find((l) => l.includes("❯"));
      expect(cursorRow).toBeDefined();
      expect(cursorRow).toContain(`${cursor + 1}. ${MODEL_CATALOG[cursor].label}`);
    }
  });

  it("shows how many models are scrolled out of view when the window is short", () => {
    const lines = renderMenuLines(MODEL_CATALOG, ctx, MODEL_CATALOG.length - 1, { columns: 100, rows: 14 });
    expect(lines.some((l) => l.includes("↑") && l.includes("more"))).toBe(true);
  });

  it("shows the entire catalog with no scroll markers when the terminal is tall enough", () => {
    const lines = renderMenuLines(MODEL_CATALOG, ctx, 0, { columns: 120, rows: 60 });
    expect(lines.some((l) => l.includes("more"))).toBe(false);
    for (const model of MODEL_CATALOG) {
      expect(lines.some((l) => l.includes(model.label))).toBe(true);
    }
  });
});
