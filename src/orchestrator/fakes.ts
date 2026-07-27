import type { OrchestratorClient, OrchestratorRequest, SubtaskPlan } from "./types.js";

/** Returns a fixed, scripted sequence of plans — one per call to decompose(). */
export class ScriptedOrchestratorClient implements OrchestratorClient {
  private plans: SubtaskPlan[];
  private callCount = 0;
  receivedRequests: OrchestratorRequest[] = [];

  constructor(plans: SubtaskPlan[]) {
    this.plans = plans;
  }

  async decompose(request: OrchestratorRequest): Promise<SubtaskPlan> {
    this.receivedRequests.push(request);
    const plan = this.plans[this.callCount];
    if (!plan) {
      throw new Error(
        `ScriptedOrchestratorClient ran out of scripted plans after ${this.callCount} call(s)`
      );
    }
    this.callCount++;
    return plan;
  }
}
