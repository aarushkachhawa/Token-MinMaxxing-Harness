export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; toolCallId: string; toolName: string; result: unknown };

export interface ToolDefinition {
  description: string;
  /** JSON-schema-shaped, kept as unknown until we pick a concrete schema library for the real provider client. */
  parameters: unknown;
}

export interface ToolCall {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface GenerateOptions {
  systemPrompt?: string;
  messages: Message[];
  tools: Record<string, ToolDefinition>;
}

export interface GenerateResult {
  /** Present when the model wants to call tools; empty means this turn is a final answer. */
  toolCalls: ToolCall[];
  text: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

/** Provider-agnostic boundary the executor talks to. Real implementations wrap the AI SDK. */
export interface ModelClient {
  generate(options: GenerateOptions): Promise<GenerateResult>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: unknown;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export type TraceEntry =
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; toolName: string; args: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; result: unknown }
  | { type: "tool_error"; toolName: string; error: string };

export interface ExecutionResult {
  finalText: string;
  turns: number;
  toolCallCount: number;
  usage: { inputTokens: number; outputTokens: number };
  trace: TraceEntry[];
  stopReason: "final_answer" | "max_turns_exceeded";
}

export interface ExecutorOptions {
  maxTurns?: number;
}
