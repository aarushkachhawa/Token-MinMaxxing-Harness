import type { DeterministicCheck, JudgeClient, JudgeRequest } from "./types.js";

export function fakeCheck(name: string, passes: boolean): DeterministicCheck {
  return {
    name,
    async run() {
      return passes;
    },
  };
}

/** Returns a fixed, scripted sequence of scores — one per call to judge(). */
export class ScriptedJudgeClient implements JudgeClient {
  private scores: number[];
  private callCount = 0;
  receivedRequests: JudgeRequest[] = [];

  constructor(scores: number[]) {
    this.scores = scores;
  }

  async judge(request: JudgeRequest): Promise<number> {
    this.receivedRequests.push(request);
    const score = this.scores[this.callCount];
    if (score === undefined) {
      throw new Error(`ScriptedJudgeClient ran out of scripted scores after ${this.callCount} call(s)`);
    }
    this.callCount++;
    return score;
  }
}
