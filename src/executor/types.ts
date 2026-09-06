import type { ZodTypeAny } from "zod";

export type Message =
  | { role: "user"; content: string }
  /** toolCalls is always non-empty in practice: a final-answer turn (no tool calls) ends the
   * run immediately and is never appended to history -- see Executor.run(). */
  | { role: "assistant"; content: string | null; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; result: unknown };

export interface ToolDefinition {
  description: string;
  parameters: ZodTypeAny;
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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Portion of inputTokens served from an Anthropic prompt-cache read, billed at a fraction of
   * the normal input rate. Undefined/0 for a provider or path that doesn't support caching. */
  cacheReadTokens?: number;
  /** Portion of inputTokens newly written to the prompt cache this call, billed at a premium over
   * the normal input rate in exchange for cheaper reads on later calls. */
  cacheWriteTokens?: number;
}

export interface GenerateResult {
  /** Present when the model wants to call tools; empty means this turn is a final answer. */
  toolCalls: ToolCall[];
  text: string | null;
  usage: TokenUsage;
}

/** Provider-agnostic boundary the executor talks to. Real implementations wrap the AI SDK. */
export interface ModelClient {
  generate(options: GenerateOptions): Promise<GenerateResult>;
}

/**
 * Turns a router's chosen modelId into the real ModelClient that should actually execute against
 * it -- the missing link between a routing *decision* and routing *taking effect*. Without this,
 * a caller can only ever run every subtask against one fixed client regardless of what the bandit
 * or escalation path picked; see SubtaskRunner.attempt(), the one place this gets called.
 */
export interface ModelClientFactory {
  getClient(modelId: string): ModelClient;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ZodTypeAny;
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
  usage: TokenUsage;
  trace: TraceEntry[];
  stopReason: "final_answer" | "max_turns_exceeded";
}

export interface ExecutorOptions {
  maxTurns?: number;
}
