import type { ModelMessage, SystemModelMessage } from "ai";

/**
 * A single Anthropic ephemeral cache breakpoint -- "cache everything in this request up through
 * this point, at the standard 5-minute TTL." Matches the shape @ai-sdk/anthropic reads at
 * providerOptions.anthropic.cacheControl on a system message, a tool definition, or a
 * conversation message. Reused directly (not just through cachedSystemPrompt below) wherever a
 * tool definition or a growing conversation's trailing message needs the same breakpoint -- see
 * anthropic-model-client.ts.
 */
export const EPHEMERAL_CACHE_CONTROL = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
};

/**
 * Wraps a static system prompt string with an Anthropic ephemeral cache breakpoint. Every system
 * prompt in this codebase (orchestrator triage/structure/replan, the judge rubric, classifier,
 * escalation, executor, conversation summarizer) is a fixed string reused across every call in a
 * session -- caching it means only the first call in a session pays full price for it; every
 * later call within the cache's TTL reads it back at a fraction of the cost instead of paying for
 * it again from scratch. This is exactly the lever a real agent loop (e.g. Claude Code's own)
 * relies on for cost efficiency and this harness didn't use at all before.
 */
export function cachedSystemPrompt(content: string): SystemModelMessage {
  return { role: "system", content, providerOptions: EPHEMERAL_CACHE_CONTROL };
}

/**
 * Marks the last message in a (possibly empty) conversation array with an Anthropic cache
 * breakpoint, leaving every earlier message untouched. Used by AnthropicModelClient on every turn
 * of Executor.run()'s tool-use loop: the message array grows by one exchange each turn while
 * being resent in full every time, so marking the trailing message rolls the cache boundary
 * forward turn over turn -- each new turn reads everything up through the *previous* turn's
 * marked message back at the cheap cache-read rate, paying full price only for what's newly
 * appended since then. Without this, a multi-turn subtask re-pays for its own growing history on
 * every single turn.
 */
export function withCacheBreakpointOnLastMessage(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  return [...messages.slice(0, -1), { ...last, providerOptions: EPHEMERAL_CACHE_CONTROL }];
}
