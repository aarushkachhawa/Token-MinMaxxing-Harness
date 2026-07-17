import { DEFAULT_DECAY, type Router } from "./bandit.js";
import type { EscalationClient } from "./escalation.js";

const DEFAULT_MIN_PULLS_BEFORE_CONFIDENT = 5;

export interface HybridRouterOptions {
  /** A category is treated as cold (escalate regardless of costWeight) if every arm has fewer than this many effective pulls. */
  minPullsBeforeConfident?: number;
}

export interface RouteOptions {
  costWeight?: number;
  /** Set when an upstream signal (e.g. the orchestrator's risk hint) says this subtask should escalate regardless of the bandit's confidence. */
  forceEscalate?: boolean;
}

export interface RouteDecision {
  modelId: string;
  escalated: boolean;
}

/**
 * The router as designed: Thompson sampling handles the default case, with LLM escalation
 * reserved for a cold category (no arm has enough evidence yet) or an explicit risk flag.
 */
export class HybridRouter {
  private bandit: Router;
  private escalationClient: EscalationClient;
  private minPulls: number;

  constructor(bandit: Router, escalationClient: EscalationClient, options: HybridRouterOptions = {}) {
    this.bandit = bandit;
    this.escalationClient = escalationClient;
    this.minPulls = options.minPullsBeforeConfident ?? DEFAULT_MIN_PULLS_BEFORE_CONFIDENT;
  }

  async route(category: string, taskDescription: string, options: RouteOptions = {}): Promise<RouteDecision> {
    const candidates = this.bandit.getCandidates(category);
    if (candidates.length === 0) {
      throw new Error(`Unknown category "${category}"`);
    }

    const isCold = candidates.every((c) => c.pulls < this.minPulls);
    if (options.forceEscalate || isCold) {
      const modelId = await this.escalationClient.chooseModel({ category, taskDescription, candidates });
      const validModelIds = new Set(candidates.map((c) => c.modelId));
      if (!validModelIds.has(modelId)) {
        throw new Error(
          `Escalation client chose an unregistered model "${modelId}" for category "${category}"`
        );
      }
      return { modelId, escalated: true };
    }

    const modelId = this.bandit.route(category, options.costWeight ?? 0);
    return { modelId, escalated: false };
  }

  register(
    category: string,
    modelId: string,
    cost: number,
    priorAlpha = 2,
    priorBeta = 1,
    decay: number = DEFAULT_DECAY
  ): void {
    this.bandit.register(category, modelId, cost, priorAlpha, priorBeta, decay);
  }

  resetArm(
    category: string,
    modelId: string,
    cost: number,
    priorAlpha = 2,
    priorBeta = 1,
    decay: number = DEFAULT_DECAY
  ): void {
    this.bandit.resetArm(category, modelId, cost, priorAlpha, priorBeta, decay);
  }

  reportOutcome(category: string, modelId: string, reward: number): void {
    this.bandit.reportOutcome(category, modelId, reward);
  }
}
