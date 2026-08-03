import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { TraceEntry } from "../executor/types.js";
import { JUDGE_RUBRIC } from "./judge-rubric.js";
import type { JudgeClient, JudgeRequest } from "./types.js";

export interface AnthropicJudgeClientOptions {
  apiKey: string;
  /** Should be a stronger/more expensive model than the ones being judged -- see
   * docs/architecture.md's Reward signal section. */
  modelId?: string;
  /** Called with the full structured verdict after every judge() call. JudgeClient.judge() only
   * returns a bare score, so this is the only way to see the rationale and evidence behind it --
   * without it, a bad verdict is indistinguishable from a good one until it's already biased an
   * arm's posterior. */
  onVerdict?: (verdict: JudgeVerdict) => void;
}

export interface JudgeVerdict {
  request: JudgeRequest;
  /** The score actually returned to the caller, after low-confidence damping. */
  score: number;
  /** The model's own score, before damping. */
  rawScore: number;
  confidence: "low" | "medium" | "high";
  rationale: string;
  evidence: string[];
}

const DEFAULT_MODEL_ID = "claude-sonnet-5";

const verdictSchema = z.object({
  score: z.number().min(0).max(1),
  confidence: z.enum(["low", "medium", "high"]),
  rationale: z.string(),
  evidence: z.array(z.string()),
});

/**
 * Real JudgeClient backed by the Vercel AI SDK. See judge-rubric.ts for what it checks and why --
 * in short, it verifies the task got done using only trace evidence, and deliberately never asks
 * the model to independently assess whether the code itself is correct.
 */
export class AnthropicJudgeClient implements JudgeClient {
  private model: ReturnType<ReturnType<typeof createAnthropic>>;
  private onVerdict?: (verdict: JudgeVerdict) => void;

  constructor(options: AnthropicJudgeClientOptions) {
    const provider = createAnthropic({ apiKey: options.apiKey });
    this.model = provider(options.modelId ?? DEFAULT_MODEL_ID);
    this.onVerdict = options.onVerdict;
  }

  async judge(request: JudgeRequest): Promise<number> {
    const { object } = await generateObject({
      model: this.model,
      schema: verdictSchema,
      system: JUDGE_RUBRIC,
      prompt: formatJudgePrompt(request),
    });

    const score = dampen(object.score, object.confidence);
    const verdict: JudgeVerdict = { ...object, request, score, rawScore: object.score };
    if (object.confidence === "low") {
      console.warn(`[AnthropicJudgeClient] low-confidence verdict (raw ${object.score} -> ${score}): ${object.rationale}`);
    }
    this.onVerdict?.(verdict);
    return score;
  }
}

/** Pulls low-confidence scores toward neutral so a shaky verdict can't swing the reward as hard as
 * a well-evidenced one -- see judge-rubric.ts for why "unsure" should look like 0.5, not a guess. */
export function dampen(score: number, confidence: "low" | "medium" | "high"): number {
  if (confidence !== "low") return score;
  return 0.5 + (score - 0.5) * 0.4;
}

export function formatJudgePrompt(request: JudgeRequest): string {
  const { taskDescription, result } = request;
  const trace = result.trace.map(describeTraceEntry).join("\n") || "(no trace entries)";

  return `Task requested:
${taskDescription}

Execution trace:
${trace}

Final output:
${result.finalText || "(empty)"}

Stop reason: ${result.stopReason}
Turns: ${result.turns}, tool calls: ${result.toolCallCount}`;
}

function describeTraceEntry(entry: TraceEntry): string {
  switch (entry.type) {
    case "assistant_text":
      return `[assistant] ${entry.text}`;
    case "tool_call":
      return `[tool_call] ${entry.toolName}(${JSON.stringify(entry.args)})`;
    case "tool_result":
      return `[tool_result] ${entry.toolName} -> ${JSON.stringify(entry.result)}`;
    case "tool_error":
      return `[tool_error] ${entry.toolName}: ${entry.error}`;
  }
}
