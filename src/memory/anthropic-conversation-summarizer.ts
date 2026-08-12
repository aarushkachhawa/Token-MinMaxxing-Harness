import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { cachedSystemPrompt } from "../executor/prompt-caching.js";
import type { ConversationTurn } from "../orchestrator/types.js";
import type { ConversationSummarizerClient } from "./types.js";

export interface AnthropicConversationSummarizerClientOptions {
  apiKey: string;
  modelId?: string;
}

// Cheapest tier on purpose: summarizing a turn that's about to leave full detail is exactly the
// low-stakes, high-volume task this harness's whole premise says shouldn't burn a strong model.
const DEFAULT_MODEL_ID = "claude-haiku-4-5-20251001";
/** Cap on how much of a turn's answer feeds into the summarization prompt -- summarizing shouldn't cost more than what it's compacting. */
const MAX_INPUT_ANSWER_LENGTH = 2000;

const SUMMARIZER_SYSTEM_PROMPT = `You compress one turn of a coding-assistant session into a single \
dense sentence for a future, unrelated request to skim as background context. Keep concrete, \
referenceable facts -- file/function/class names, specific findings, decisions made -- and drop \
preamble, filler, and generic phrasing. Output only the sentence itself, no preface like "Summary:".`;

/**
 * Real ConversationSummarizerClient backed by the Vercel AI SDK.
 *
 * Called once per turn, exactly when it ages out of formatConversationHistory's recent-detail
 * window (see findTurnsNeedingSummary in anthropic-orchestrator-client.ts), and the result is
 * cached on the turn itself -- not recomputed on every prompt, so a long session doesn't keep
 * re-summarizing the same turn over and over.
 */
export class AnthropicConversationSummarizerClient implements ConversationSummarizerClient {
  private model: ReturnType<ReturnType<typeof createAnthropic>>;

  constructor(options: AnthropicConversationSummarizerClientOptions) {
    const provider = createAnthropic({ apiKey: options.apiKey });
    this.model = provider(options.modelId ?? DEFAULT_MODEL_ID);
  }

  async summarize(turn: ConversationTurn): Promise<string> {
    const { text } = await generateText({
      model: this.model,
      system: cachedSystemPrompt(SUMMARIZER_SYSTEM_PROMPT),
      prompt: formatSummarizationPrompt(turn),
    });
    return text.trim();
  }
}

/** Pure prompt construction, unit tested separately from the actual API call. */
export function formatSummarizationPrompt(turn: ConversationTurn): string {
  return `User: ${turn.requestDescription}\nAnswer: ${truncate(turn.finalText, MAX_INPUT_ANSWER_LENGTH)}`;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
