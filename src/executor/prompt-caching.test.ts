import { describe, expect, it } from "vitest";
import {
  cachedSystemPrompt,
  EPHEMERAL_CACHE_CONTROL,
  EPHEMERAL_CACHE_CONTROL_LONG,
  withCacheBreakpointOnLastMessage,
} from "./prompt-caching.js";
import type { ModelMessage } from "ai";

describe("cachedSystemPrompt", () => {
  it("defaults to a 1-hour ephemeral cache breakpoint", () => {
    const result = cachedSystemPrompt("You are a careful coding assistant.");

    expect(result).toEqual({
      role: "system",
      content: "You are a careful coding assistant.",
      providerOptions: EPHEMERAL_CACHE_CONTROL_LONG,
    });
  });

  it("honors an explicit shorter TTL", () => {
    const result = cachedSystemPrompt("You are a careful coding assistant.", "5m");

    expect(result).toEqual({
      role: "system",
      content: "You are a careful coding assistant.",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
    });
  });

  it("preserves the exact content string, including multi-paragraph prompts", () => {
    const prompt = "Line one.\n\nLine two with more detail.";
    expect(cachedSystemPrompt(prompt).content).toBe(prompt);
  });
});

describe("EPHEMERAL_CACHE_CONTROL", () => {
  it("matches the shape @ai-sdk/anthropic expects at providerOptions.anthropic.cacheControl", () => {
    expect(EPHEMERAL_CACHE_CONTROL).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });
});

describe("EPHEMERAL_CACHE_CONTROL_LONG", () => {
  it("requests the 1-hour ephemeral TTL", () => {
    expect(EPHEMERAL_CACHE_CONTROL_LONG).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
  });
});

describe("withCacheBreakpointOnLastMessage", () => {
  function userMessage(text: string): ModelMessage {
    return { role: "user", content: text };
  }

  it("returns an empty array unchanged", () => {
    expect(withCacheBreakpointOnLastMessage([])).toEqual([]);
  });

  it("marks only the last message, leaving earlier messages untouched", () => {
    const messages = [userMessage("first"), userMessage("second"), userMessage("third")];

    const result = withCacheBreakpointOnLastMessage(messages);

    expect(result[0]).toEqual(userMessage("first"));
    expect(result[1]).toEqual(userMessage("second"));
    expect(result[2]).toEqual({ ...userMessage("third"), providerOptions: EPHEMERAL_CACHE_CONTROL });
  });

  it("marks the only message when there's just one", () => {
    const result = withCacheBreakpointOnLastMessage([userMessage("only")]);
    expect(result).toEqual([{ ...userMessage("only"), providerOptions: EPHEMERAL_CACHE_CONTROL }]);
  });

  it("does not mutate the input array or its messages", () => {
    const original = [userMessage("a"), userMessage("b")];
    const originalLast = original[1];

    withCacheBreakpointOnLastMessage(original);

    expect(original[1]).toBe(originalLast);
    expect(original[1]).not.toHaveProperty("providerOptions");
  });
});
