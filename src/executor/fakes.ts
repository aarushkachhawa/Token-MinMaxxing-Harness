import type { GenerateOptions, GenerateResult, ModelClient, Tool } from "./types.js";

/** Returns a fixed, scripted sequence of responses — one per call to generate(). */
export class ScriptedModelClient implements ModelClient {
  private responses: GenerateResult[];
  private callCount = 0;
  /** Every options object the executor passed in, in call order — useful for asserting message flow. */
  receivedOptions: GenerateOptions[] = [];

  constructor(responses: GenerateResult[]) {
    this.responses = responses;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    this.receivedOptions.push(options);
    const response = this.responses[this.callCount];
    if (!response) {
      throw new Error(
        `ScriptedModelClient ran out of scripted responses after ${this.callCount} call(s)`
      );
    }
    this.callCount++;
    return response;
  }
}

export function fakeTool(
  name: string,
  execute: (args: Record<string, unknown>) => Promise<unknown> = async () => ({ ok: true })
): Tool {
  return {
    name,
    description: `fake tool "${name}"`,
    parameters: {},
    execute,
  };
}
