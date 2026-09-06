import { execFile, spawn } from "node:child_process";

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const PROBE_TIMEOUT_MS = 1500;

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  /** Model names as reported by `ollama list` (via /api/tags), e.g. "qwen2.5-coder:7b". */
  localModels: string[];
}

/**
 * Checked before anything else in /models -- Ollama is the only provider that's free and needs
 * no API key, so surfacing "is it even installed/running, and what's already pulled" up front
 * (rather than discovering it lazily per-model) is what "configure Ollama first" means here.
 */
export async function checkOllamaStatus(): Promise<OllamaStatus> {
  const installed = await isOllamaInstalled();
  if (!installed) {
    return { installed: false, running: false, localModels: [] };
  }

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { installed: true, running: false, localModels: [] };
    }
    const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const localModels = (body.models ?? [])
      .map((m) => m.name ?? m.model)
      .filter((name): name is string => Boolean(name));
    return { installed: true, running: true, localModels };
  } catch {
    return { installed: true, running: false, localModels: [] };
  }
}

function isOllamaInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ollama", ["--version"], (error) => resolve(!error));
  });
}

/** Pure so it's unit-testable without a real Ollama install. */
export function isModelPulled(modelId: string, status: OllamaStatus): boolean {
  return status.localModels.includes(modelId);
}

/** Pure status-line formatting, split out from checkOllamaStatus so it's testable without a real
 * Ollama process. */
export function formatOllamaStatusLine(status: OllamaStatus): string {
  if (!status.installed) {
    return "Ollama: not installed -- install it from https://ollama.com/download to use local models.";
  }
  if (!status.running) {
    return "Ollama: installed but not running -- start it with `ollama serve` (or open the Ollama app).";
  }
  return `Ollama: running, ${status.localModels.length} model(s) already pulled.`;
}

/**
 * Runs `ollama pull <modelId>`, streaming each stdout/stderr line to onLine as it arrives (Ollama
 * prints its own download progress bar there) and resolving once the process exits successfully.
 * Only called after the user has explicitly confirmed the download in runModelsCommand.
 */
export function pullOllamaModel(modelId: string, onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ollama", ["pull", modelId], { stdio: ["ignore", "pipe", "pipe"] });

    const forward = (chunk: Buffer) => onLine?.(chunk.toString("utf-8").trimEnd());
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ollama pull ${modelId} exited with code ${code}`));
    });
  });
}
