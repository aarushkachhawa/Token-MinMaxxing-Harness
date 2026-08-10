import type { OrchestratorClient, OrchestratorRequest, ReplanContext, SubtaskPlan } from "./types.js";

/**
 * Returns a fixed, scripted sequence of plans — one per call to decompose(), and a separate
 * scripted sequence for replan() calls, since a test scenario often needs to script both an
 * initial plan and one or more replans against it.
 */
export class ScriptedOrchestratorClient implements OrchestratorClient {
  private plans: SubtaskPlan[];
  private callCount = 0;
  private replanPlans: SubtaskPlan[];
  private replanCallCount = 0;
  receivedRequests: OrchestratorRequest[] = [];
  receivedReplanRequests: ReplanContext[] = [];

  constructor(plans: SubtaskPlan[], replanPlans: SubtaskPlan[] = []) {
    this.plans = plans;
    this.replanPlans = replanPlans;
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

  async replan(context: ReplanContext): Promise<SubtaskPlan> {
    this.receivedReplanRequests.push(context);
    const plan = this.replanPlans[this.replanCallCount];
    if (!plan) {
      throw new Error(
        `ScriptedOrchestratorClient ran out of scripted replan plans after ${this.replanCallCount} call(s)`
      );
    }
    this.replanCallCount++;
    return plan;
  }
}
