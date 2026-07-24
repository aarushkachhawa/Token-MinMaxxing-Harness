import type { ClassifierClient, ClassifierRequest } from "./types.js";

/** Returns a fixed, scripted sequence of category choices — one per call to classify(). */
export class ScriptedClassifierClient implements ClassifierClient {
  private responses: string[];
  private callCount = 0;
  receivedRequests: ClassifierRequest[] = [];

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async classify(request: ClassifierRequest): Promise<string> {
    this.receivedRequests.push(request);
    const response = this.responses[this.callCount];
    if (response === undefined) {
      throw new Error(
        `ScriptedClassifierClient ran out of scripted responses after ${this.callCount} call(s)`
      );
    }
    this.callCount++;
    return response;
  }
}
