import type { ConversationTurn } from "../orchestrator/types.js";

/** Compresses one turn that's aged out of full detail into a dense one-sentence summary. */
export interface ConversationSummarizerClient {
  summarize(turn: ConversationTurn): Promise<string>;
}
