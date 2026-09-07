import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, tool } from "ai";
import { toModelMessage } from "./message-conversion.js";
import type { GenerateOptions, GenerateResult, ModelClient, ToolCall } from "./types.js";

export interface OllamaModelClientOptions {
  modelId: string;
  /** Ollama's OpenAI-compatible endpoint, e.g. "http://localhost:11434/v1". */
  baseUrl: string;
}

/**
 * ModelClient backed by a local Ollama server, talked to through its OpenAI-compatible
 * `/v1/chat/completions` endpoint (`@ai-sdk/openai-compatible`) rather than a dedicated Ollama
 * SDK -- Ollama implements that surface directly, so no extra provider-specific dependency is
 * needed. Intended for the harness's cheapest tier: trivial subtasks routed to a model that costs
 * nothing per token because it runs on the user's own machine.
 *
 * No prompt-cache breakpoints here (unlike AnthropicModelClient) -- Ollama's OpenAI-compatible
 * endpoint has no equivalent of Anthropic's cache_control, and there's no per-token bill to save
 * against locally anyway.
 */
export class OllamaModelClient implements ModelClient {
  private model: ReturnType<ReturnType<typeof createOpenAICompatible>>;

  constructor(options: OllamaModelClientOptions) {
    const provider = createOpenAICompatible({ name: "ollama", baseURL: options.baseUrl });
    this.model = provider(options.modelId);
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const result = await generateText({
      model: this.model,
      system: options.systemPrompt,
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
