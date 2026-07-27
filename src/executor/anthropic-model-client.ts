import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, tool, type ModelMessage } from "ai";
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
 */
export class AnthropicModelClient implements ModelClient {
  private model: ReturnType<ReturnType<typeof createAnthropic>>;

  constructor(options: AnthropicModelClientOptions) {
    const provider = createAnthropic({ apiKey: options.apiKey });
    this.model = provider(options.modelId ?? DEFAULT_MODEL_ID);
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const result = await generateText({
      model: this.model,
      instructions: options.systemPrompt,
      messages: options.messages.map(toModelMessage),
      tools: Object.fromEntries(
        Object.entries(options.tools).map(([name, def]) => [
          name,
          tool({ description: def.description, inputSchema: def.parameters }),
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
    case "assistant":
      return { role: "assistant", content: message.content };
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
