import type {
  ExecutionResult,
  ExecutorOptions,
  Message,
  ModelClient,
  Tool,
  ToolDefinition,
  TraceEntry,
} from "./types.js";

const DEFAULT_MAX_TURNS = 10;

/** Runs the tool-use loop for one worker call: model turn -> tool calls -> tool results -> repeat. */
export class Executor {
  private client: ModelClient;
  private tools: Map<string, Tool>;
  private toolDefs: Record<string, ToolDefinition>;
  private maxTurns: number;

  constructor(client: ModelClient, tools: Tool[], options: ExecutorOptions = {}) {
    this.client = client;
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.toolDefs = Object.fromEntries(
      tools.map((tool) => [tool.name, { description: tool.description, parameters: tool.parameters }])
    );
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  }

  async run(systemPrompt: string, initialUserMessage: string): Promise<ExecutionResult> {
    const messages: Message[] = [{ role: "user", content: initialUserMessage }];
    const trace: TraceEntry[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCallCount = 0;
    let turns = 0;

    while (turns < this.maxTurns) {
      turns++;
      const result = await this.client.generate({
        systemPrompt,
        messages,
        tools: this.toolDefs,
      });
      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;

      if (result.toolCalls.length === 0) {
        const finalText = result.text ?? "";
        trace.push({ type: "assistant_text", text: finalText });
        return {
          finalText,
          turns,
          toolCallCount,
          usage: { inputTokens, outputTokens },
          trace,
          stopReason: "final_answer",
        };
      }

      if (result.text) {
        messages.push({ role: "assistant", content: result.text });
        trace.push({ type: "assistant_text", text: result.text });
      }

      for (const call of result.toolCalls) {
        toolCallCount++;
        trace.push({ type: "tool_call", toolName: call.toolName, args: call.args });

        const tool = this.tools.get(call.toolName);
        if (!tool) {
          const error = `Unknown tool "${call.toolName}"`;
          trace.push({ type: "tool_error", toolName: call.toolName, error });
          messages.push({ role: "tool", toolCallId: call.id, toolName: call.toolName, result: { error } });
          continue;
        }

        try {
          const toolResult = await tool.execute(call.args);
          trace.push({ type: "tool_result", toolName: call.toolName, result: toolResult });
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.toolName,
            result: toolResult,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          trace.push({ type: "tool_error", toolName: call.toolName, error });
          messages.push({ role: "tool", toolCallId: call.id, toolName: call.toolName, result: { error } });
        }
      }
    }

    return {
      finalText: "",
      turns,
      toolCallCount,
      usage: { inputTokens, outputTokens },
      trace,
      stopReason: "max_turns_exceeded",
    };
  }
}
