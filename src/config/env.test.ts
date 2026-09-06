import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistApiKey, upsertDotEnvLine } from "./env.js";

describe("upsertDotEnvLine", () => {
  it("appends a new line to empty contents", () => {
    expect(upsertDotEnvLine("", "OPENAI_API_KEY", "sk-abc")).toBe("OPENAI_API_KEY=sk-abc\n");
  });

  it("appends after existing lines, keeping them untouched", () => {
    const result = upsertDotEnvLine("ANTHROPIC_API_KEY=sk-ant\n", "OPENAI_API_KEY", "sk-abc");
    expect(result).toBe("ANTHROPIC_API_KEY=sk-ant\nOPENAI_API_KEY=sk-abc\n");
  });

  it("replaces an existing line for the same key instead of duplicating it", () => {
    const result = upsertDotEnvLine("ANTHROPIC_API_KEY=old\nOPENAI_API_KEY=sk-abc\n", "ANTHROPIC_API_KEY", "new");
    expect(result).toBe("ANTHROPIC_API_KEY=new\nOPENAI_API_KEY=sk-abc\n");
  });

  it("quotes a value containing a space", () => {
    expect(upsertDotEnvLine("", "SOME_VAR", "has space")).toBe('SOME_VAR="has space"\n');
  });
});

describe("persistApiKey", () => {
  let dir: string;
  let dotEnvPath: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tmh-env-"));
    dotEnvPath = join(dir, ".env");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it("sets process.env immediately and writes the key to the .env file", async () => {
    persistApiKey("OPENAI_API_KEY", "sk-test-123", dotEnvPath);

    expect(process.env.OPENAI_API_KEY).toBe("sk-test-123");
    const contents = await readFile(dotEnvPath, "utf-8");
    expect(contents).toContain("OPENAI_API_KEY=sk-test-123");
  });

  it("creates the .env file if it doesn't exist yet", async () => {
    persistApiKey("GOOGLE_GENERATIVE_AI_API_KEY", "gk-123", dotEnvPath);
    const contents = await readFile(dotEnvPath, "utf-8");
    expect(contents).toBe("GOOGLE_GENERATIVE_AI_API_KEY=gk-123\n");
  });
});
