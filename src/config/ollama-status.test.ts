import { describe, expect, it } from "vitest";
import { formatOllamaStatusLine, isModelPulled, type OllamaStatus } from "./ollama-status.js";

describe("formatOllamaStatusLine", () => {
  it("reports not installed", () => {
    const status: OllamaStatus = { installed: false, running: false, localModels: [] };
    expect(formatOllamaStatusLine(status)).toContain("not installed");
  });

  it("reports installed but not running", () => {
    const status: OllamaStatus = { installed: true, running: false, localModels: [] };
    expect(formatOllamaStatusLine(status)).toContain("not running");
  });

  it("reports running with a model count", () => {
    const status: OllamaStatus = { installed: true, running: true, localModels: ["llama3.1:8b", "qwen2.5-coder:7b"] };
    expect(formatOllamaStatusLine(status)).toContain("2 model(s)");
  });
});

describe("isModelPulled", () => {
  const status: OllamaStatus = { installed: true, running: true, localModels: ["llama3.1:8b"] };

  it("is true for a model already in localModels", () => {
    expect(isModelPulled("llama3.1:8b", status)).toBe(true);
  });

  it("is false for a model not in localModels", () => {
    expect(isModelPulled("qwen2.5-coder:7b", status)).toBe(false);
  });
});
