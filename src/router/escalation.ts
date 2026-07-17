import type { CandidateStats } from "./bandit.js";

export interface EscalationRequest {
  category: string;
  taskDescription: string;
  candidates: CandidateStats[];
}

/** Reads the actual task (not just a category label) and picks a model id from the candidates. */
export interface EscalationClient {
  chooseModel(request: EscalationRequest): Promise<string>;
}

/** Returns a fixed, scripted sequence of choices — one per call to chooseModel(). */
export class ScriptedEscalationClient implements EscalationClient {
  private responses: string[];
  private callCount = 0;
  receivedRequests: EscalationRequest[] = [];

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async chooseModel(request: EscalationRequest): Promise<string> {
    this.receivedRequests.push(request);
    const response = this.responses[this.callCount];
    if (response === undefined) {
      throw new Error(
        `ScriptedEscalationClient ran out of scripted responses after ${this.callCount} call(s)`
      );
    }
    this.callCount++;
    return response;
  }
}
