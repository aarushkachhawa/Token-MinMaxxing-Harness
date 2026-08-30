import type { ModelMessage, SystemModelMessage } from "ai";

/** Anthropic's two ephemeral cache lifetimes -- see ephemeralCacheControl() below. */
export type CacheTtl = "5m" | "1h";

function ephemeralCacheControl(ttl?: CacheTtl) {
  return {
    anthropic: { cacheControl: { type: "ephemeral" as const, ...(ttl ? { ttl } : {}) } },
  };
}

/**
 * A single Anthropic ephemeral cache breakpoint at the server's default (5-minute) TTL. Matches
 * the shape @ai-sdk/anthropic reads at providerOptions.anthropic.cacheControl on a system message,
 * a tool definition, or a conversation message. Reserved for content that's rebuilt/superseded
 * every turn -- the rolling "last message" boundary in withCacheBreakpointOnLastMessage below --
 * where a longer TTL would only add the 1-hour write premium without the breakpoint ever living
 * long enough to pay it back in reads: it's superseded by the next turn's own marked message
 * before a 5-minute window would even lapse.
 */
export const EPHEMERAL_CACHE_CONTROL = ephemeralCacheControl();

/**
 * A 1-hour ephemeral cache breakpoint, for content that's byte-identical across every subtask/call
 * for the life of a whole run rather than rolling forward turn by turn -- the tool definitions
 * (anthropic-model-client.ts marks the last one) and, via cachedSystemPrompt's default below,
 * every static system prompt in this codebase. The default 5-minute TTL routinely expires between
 * independent subtask attempts (classification, routing, tool-use turns, reward scoring all sit
 * in between), throwing away a cache write that a real run would otherwise still be reading back
 * an hour later. Anthropic bills a 1-hour write at roughly double a 5-minute write's premium, but
 * that's a one-time cost paid once per hour of wall-clock time, amortized across however many
 * subtasks' worth of reads land inside that hour -- for anything read more than a couple of times
 * per hour, the 1-hour TTL is strictly cheaper than repeatedly paying the 5-minute write premium
 * every time the short TTL lapses between calls.
 */
export const EPHEMERAL_CACHE_CONTROL_LONG = ephemeralCacheControl("1h");

/**
 * Wraps a static system prompt string with an Anthropic ephemeral cache breakpoint, defaulting to
 * the 1-hour TTL. Every system prompt in this codebase (orchestrator triage/explore/structure/
 * replan, the judge rubric, classifier, escalation, executor, conversation summarizer) is a fixed
 * string reused across every call for the life of a whole run, not just within one subtask -- the
 * 1-hour default means only the first call in an hour pays full price for it; every later call
 * within that TTL reads it back at a fraction of the cost instead of paying for it again from
 * scratch. This is exactly the lever a real agent loop (e.g. Claude Code's own) relies on for cost
 * efficiency and this harness didn't use at all before.
 */
export function cachedSystemPrompt(content: string, ttl: CacheTtl = "1h"): SystemModelMessage {
  return { role: "system", content, providerOptions: ephemeralCacheControl(ttl) };
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
