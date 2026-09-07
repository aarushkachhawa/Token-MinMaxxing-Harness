import type { ModelMessage, TextPart, ToolCallPart } from "ai";
import type { Message } from "./types.js";

/** Shared by every AI-SDK-backed ModelClient (Anthropic, Ollama, ...) -- the harness's Message
 * union is provider-agnostic, so translating it into the SDK's ModelMessage shape doesn't vary
 * by provider. */
export function toModelMessage(message: Message): ModelMessage {
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
