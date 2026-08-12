import type { ConversationTurn } from "../orchestrator/types.js";
import type { ConversationSummarizerClient } from "./types.js";

/** Returns a fixed, scripted sequence of summaries, one per call to summarize(). */
export class ScriptedConversationSummarizerClient implements ConversationSummarizerClient {
  private summaries: string[];
  private callCount = 0;
  receivedTurns: ConversationTurn[] = [];

  constructor(summaries: string[]) {
    this.summaries = summaries;
  }

  async summarize(turn: ConversationTurn): Promise<string> {
    this.receivedTurns.push(turn);
    const summary = this.summaries[this.callCount];
    if (summary === undefined) {
      throw new Error(
        `ScriptedConversationSummarizerClient ran out of scripted summaries after ${this.callCount} call(s)`
      );
    }
    this.callCount++;
    return summary;
  }
}
