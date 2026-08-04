import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { ClassifierClient, ClassifierRequest } from "./types.js";

export interface AnthropicClassifierClientOptions {
  apiKey: string;
  modelId?: string;
}

const DEFAULT_MODEL_ID = "claude-haiku-4-5-20251001"; // narrow single-choice decision -- cheap tier is enough

const SYSTEM_PROMPT = `You are the fallback classifier of a coding harness's task-routing pipeline. \
Cheap keyword heuristics already tried to categorize this task and either found no match at all or an \
ambiguous (conflicting) match between multiple categories. Pick exactly one category from the given \
list that best fits what the task actually is.`;

/**
 * Real ClassifierClient backed by the Vercel AI SDK. The output schema is a Zod enum built from
 * the request's own candidateCategories, so an invalid category is rejected by the SDK's schema
 * validation itself rather than relying on TaskClassifier's post-hoc check (which still runs too,
 * as a second line of defense against any ClassifierClient implementation, not just this one).
 */
export class AnthropicClassifierClient implements ClassifierClient {
  private model: ReturnType<ReturnType<typeof createAnthropic>>;

  constructor(options: AnthropicClassifierClientOptions) {
    const provider = createAnthropic({ apiKey: options.apiKey });
    this.model = provider(options.modelId ?? DEFAULT_MODEL_ID);
  }

  async classify(request: ClassifierRequest): Promise<string> {
    if (request.candidateCategories.length === 0) {
      throw new Error("AnthropicClassifierClient: no candidate categories to choose from");
    }
    const schema = z.object({
      category: z.enum(request.candidateCategories as [string, ...string[]]),
    });

    const { object } = await generateObject({
      model: this.model,
      schema,
      system: SYSTEM_PROMPT,
      prompt: formatClassifierPrompt(request),
    });
    return object.category;
  }
}

export function formatClassifierPrompt(request: ClassifierRequest): string {
  const matchedNote =
    request.matchedCategories.length > 0
      ? `The heuristics ambiguously matched: ${request.matchedCategories.join(", ")}.`
      : "The heuristics found no match at all.";

  return `Task: ${request.taskDescription}

${matchedNote}

Candidate categories: ${request.candidateCategories.join(", ")}`;
}
