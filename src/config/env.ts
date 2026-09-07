import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function getAnthropicApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill in a real key, " +
        "then run with `node --env-file=.env ...` (or `npm run <script> -- --env-file=.env`)."
    );
  }
  return key;
}

export function hasEnvVar(name: string): boolean {
  return Boolean(process.env[name]);
}

/**
 * Replaces (or appends) one `NAME=value` line in a .env file's text, leaving every other line
 * untouched -- split out from persistApiKey so the line-rewrite logic can be unit tested without
 * touching the filesystem.
 */
export function upsertDotEnvLine(contents: string, name: string, value: string): string {
  const escapedValue = value.includes(" ") || value.includes("#") ? `"${value}"` : value;
  const line = `${name}=${escapedValue}`;
  // Drop a trailing blank line from the split so appending never leaves a stray empty line
  // in the middle of the file once it's rejoined below.
  const lines = contents.split("\n").filter((l, i, arr) => !(l === "" && i === arr.length - 1));
  const existingIndex = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (existingIndex >= 0) {
    lines[existingIndex] = line;
  } else {
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Sets an API key for the running process (so it takes effect immediately, same session) and
 * persists it into the project's .env file (so it's still there next time the CLI starts) --
 * mirrors the existing `process.loadEnvFile()` / ANTHROPIC_API_KEY convention rather than
 * introducing a second, competing place to store credentials.
 */
export function persistApiKey(name: string, value: string, dotEnvPath: string): void {
  process.env[name] = value;
  const existing = existsSync(dotEnvPath) ? readFileSync(dotEnvPath, "utf-8") : "";
  writeFileSync(dotEnvPath, upsertDotEnvLine(existing, name, value));
}

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

/** Unlike the Anthropic key, Ollama support is opt-in and needs no credential -- a local server
 * at the default address is the common case, so this never throws. Callers decide whether the
 * absence of OLLAMA_BASE_URL means "use the default" or "don't wire up Ollama at all". */
export function getOllamaBaseUrl(): string {
  return process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
}
