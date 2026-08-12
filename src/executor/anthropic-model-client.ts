import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, tool, type ModelMessage, type TextPart, type ToolCallPart } from "ai";
import { cachedSystemPrompt, EPHEMERAL_CACHE_CONTROL, withCacheBreakpointOnLastMessage } from "./prompt-caching.js";
import type { GenerateOptions, GenerateResult, Message, ModelClient, ToolCall } from "./types.js";

export interface AnthropicModelClientOptions {
  apiKey: string;
  modelId?: string;
}

const DEFAULT_MODEL_ID = "claude-haiku-4-5-20251001";

/**
 * Real ModelClient backed by the Vercel AI SDK. Tools are defined without an `execute`
 * function, so generateText stops after generating a tool call instead of looping
 * internally -- our own Executor stays the one thing driving the multi-turn loop.
 *
 * Every call here is one turn of Executor.run()'s tool-use loop, and the message array grows by
 * one exchange (assistant tool-call + tool-result) each time while being resent in full on every
 * turn. Without caching, a 6-turn subtask pays full price for the whole growing history on every
 * single turn -- turn 6 repays for turns 1-5's content five separate times. Three cache
 * breakpoints close that gap: the system prompt, the last tool definition (Anthropic's caching
 * caches the whole prefix up through a marked block, so one breakpoint covers every tool before
 * it too), and the last message in the current turn's array. That last one is the one that
 * actually matters turn over turn: it rolls forward on every call, so each new turn reads
 * everything up through the *previous* turn's marked message back at the cheap cache-read rate
 * and only pays full price for what's newly appended since then -- the same incremental-caching
 * pattern a real agent loop (e.g. Claude Code's own) relies on for its own cost efficiency.
 */
export class AnthropicModelClient implements ModelClient {
  private model: ReturnType<ReturnType<typeof createAnthropic>>;

  constructor(options: AnthropicModelClientOptions) {
    const provider = createAnthropic({ apiKey: options.apiKey });
    this.model = provider(options.modelId ?? DEFAULT_MODEL_ID);
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const toolNames = Object.keys(options.tools);
    const lastToolName = toolNames[toolNames.length - 1];

    const result = await generateText({
      model: this.model,
      instructions: options.systemPrompt ? cachedSystemPrompt(options.systemPrompt) : undefined,
      messages: withCacheBreakpointOnLastMessage(options.messages.map(toModelMessage)),
      tools: Object.fromEntries(
        Object.entries(options.tools).map(([name, def]) => [
          name,
          tool({
            description: def.description,
            inputSchema: def.parameters,
            ...(name === lastToolName ? { providerOptions: EPHEMERAL_CACHE_CONTROL } : {}),
          }),
        ])
      ),
    });

    const toolCalls: ToolCall[] = result.toolCalls.map((call) => ({
      id: call.toolCallId,
      toolName: call.toolName,
      args: call.input as Record<string, unknown>,
    }));

    return {
      toolCalls,
      text: result.text.length > 0 ? result.text : null,
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
    };
  }
}

function toModelMessage(message: Message): ModelMessage {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant": {
      const content: Array<TextPart | ToolCallPart> = [];
      if (message.content) {
        content.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls) {
        content.push({ type: "tool-call", toolCallId: call.id, toolName: call.toolName, input: call.args });
      }
      return { role: "assistant", content };
    }
    case "tool":
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: { type: "json", value: message.result as never },
          },
        ],
      };
  }
}
