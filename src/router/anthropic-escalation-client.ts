import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { EscalationClient, EscalationRequest } from "./escalation.js";

export interface AnthropicEscalationClientOptions {
  apiKey: string;
  modelId?: string;
}

// This is a real routing decision with real cost consequences (a bad pick means either an
// unnecessary escalation to a pricier model or another failed attempt) -- worth a stronger
// default than the classifier's narrow single-choice decision.
const DEFAULT_MODEL_ID = "claude-sonnet-5";

const SYSTEM_PROMPT = `You are the escalation tier of a coding harness's model router. The \
statistical bandit either doesn't have enough data yet for this category, or the task was flagged \
high-risk. Given the task and each candidate model's current stats, pick the model most likely to \
complete this specific task well -- not necessarily the cheapest, and not necessarily the one with \
the best mean success rate if its evidence is too thin to trust yet.`;

/**
 * Real EscalationClient backed by the Vercel AI SDK. Like AnthropicClassifierClient, the output
 * schema is a Zod enum built from the request's own candidate model ids, so an invalid choice is
 * rejected by schema validation itself -- HybridRouter's own post-hoc check against its known
 * candidates still runs too, as a second line of defense against any EscalationClient.
 */
export class AnthropicEscalationClient implements EscalationClient {
  private model: ReturnType<ReturnType<typeof createAnthropic>>;

  constructor(options: AnthropicEscalationClientOptions) {
    const provider = createAnthropic({ apiKey: options.apiKey });
    this.model = provider(options.modelId ?? DEFAULT_MODEL_ID);
  }

  async chooseModel(request: EscalationRequest): Promise<string> {
    const modelIds = request.candidates.map((candidate) => candidate.modelId);
    if (modelIds.length === 0) {
      throw new Error("AnthropicEscalationClient: no candidates to choose from");
    }
    const schema = z.object({ modelId: z.enum(modelIds as [string, ...string[]]) });

    const { object } = await generateObject({
      model: this.model,
      schema,
      system: SYSTEM_PROMPT,
      prompt: formatEscalationPrompt(request),
    });
    return object.modelId;
  }
}

export function formatEscalationPrompt(request: EscalationRequest): string {
  const candidateLines = request.candidates
    .map(
      (candidate) =>
        `- ${candidate.modelId}: cost=${candidate.cost}, mean success rate=${candidate.meanSuccessRate.toFixed(2)}, pulls=${candidate.pulls.toFixed(1)}`
    )
    .join("\n");

  return `Category: ${request.category}
Task: ${request.taskDescription}

Candidates:
${candidateLines}`;
}
