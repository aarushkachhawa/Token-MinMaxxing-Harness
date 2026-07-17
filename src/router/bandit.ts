import { sampleBeta } from "./beta.js";
import { SystemRng, type Rng } from "./rng.js";

/** Default per-pull discount applied to an arm's own accumulated evidence on each update. */
export const DEFAULT_DECAY = 0.995;

/** A candidate model's current stats for a category, for observability and escalation decisions. */
export interface CandidateStats {
  modelId: string;
  cost: number;
  meanSuccessRate: number;
  /** Effective evidence accumulated so far (decayed), not a raw lifetime call count. */
  pulls: number;
}

/** One candidate model within a task category. */
export class Arm {
  modelId: string;
  cost: number;
  priorAlpha: number;
  priorBeta: number;
  alpha: number;
  beta: number;
  /** Discount in (0, 1] applied to this arm's own evidence on each update; 1 = never forget. */
  decay: number;

  constructor(
    modelId: string,
    cost: number,
    priorAlpha = 2,
    priorBeta = 1,
    decay: number = DEFAULT_DECAY
  ) {
    if (priorAlpha <= 0 || priorBeta <= 0) {
      throw new Error("priorAlpha and priorBeta must be positive");
    }
    if (decay <= 0 || decay > 1) {
      throw new Error("decay must be in (0, 1]");
    }
    this.modelId = modelId;
    this.cost = cost;
    this.priorAlpha = priorAlpha;
    this.priorBeta = priorBeta;
    this.alpha = priorAlpha;
    this.beta = priorBeta;
    this.decay = decay;
  }

  sample(rng: Rng): number {
    return sampleBeta(this.alpha, this.beta, rng);
  }

  /**
   * Apply a reward in [0, 1] (1 = full success, 0 = full failure, fractional for blended
   * signals). Existing evidence is discounted back toward the prior first, so a model whose
   * true success rate has drifted is reflected within roughly 1/(1-decay) pulls instead of
   * requiring an ever-growing number of contradicting observations to move the posterior.
   */
  update(reward: number): void {
    if (reward < 0 || reward > 1) {
      throw new Error(`reward must be in [0, 1], got ${reward}`);
    }
    this.alpha = this.priorAlpha + this.decay * (this.alpha - this.priorAlpha) + reward;
    this.beta = this.priorBeta + this.decay * (this.beta - this.priorBeta) + (1 - reward);
  }
}

/** Thompson-sampling bandit over the candidate models for one task category. */
export class CategoryRouter {
  arms: Map<string, Arm>;
  private rng: Rng;

  constructor(arms: Map<string, Arm>, rng: Rng = new SystemRng()) {
    this.arms = arms;
    this.rng = rng;
  }

  /**
   * Draw a sample from each arm's posterior and return the highest cost-adjusted score. Cost is
   * normalized to [0, 1] relative to the cheapest and priciest candidate *in this category*
   * before costWeight is applied, so a given costWeight means "how much do I care about being at
   * the expensive end of this category's price range" consistently — rather than being scaled by
   * whatever this category's absolute token volume happens to be.
   */
  select(costWeight = 0): string {
    if (this.arms.size === 0) {
      throw new Error("CategoryRouter has no registered arms");
    }

    let minCost = Infinity;
    let maxCost = -Infinity;
    for (const arm of this.arms.values()) {
      if (arm.cost < minCost) minCost = arm.cost;
      if (arm.cost > maxCost) maxCost = arm.cost;
    }
    const costRange = maxCost - minCost;

    let bestModelId: string | null = null;
    let bestScore = -Infinity;
    for (const [modelId, arm] of this.arms) {
      const normalizedCost = costRange > 0 ? (arm.cost - minCost) / costRange : 0;
      const score = arm.sample(this.rng) - costWeight * normalizedCost;
      if (score > bestScore) {
        bestScore = score;
        bestModelId = modelId;
      }
    }
    return bestModelId as string;
  }

  update(modelId: string, reward: number): void {
    const arm = this.arms.get(modelId);
    if (!arm) {
      throw new Error(`Unknown model "${modelId}" for this category`);
    }
    arm.update(reward);
  }

  getCandidates(): CandidateStats[] {
    return [...this.arms.values()].map((arm) => ({
      modelId: arm.modelId,
      cost: arm.cost,
      meanSuccessRate: arm.alpha / (arm.alpha + arm.beta),
      pulls: arm.alpha - arm.priorAlpha + (arm.beta - arm.priorBeta),
    }));
  }
}

/** Per-category Thompson-sampling router across configured worker models. */
export class Router {
  private rng: Rng;
  private categories: Map<string, CategoryRouter> = new Map();

  constructor(rng: Rng = new SystemRng()) {
    this.rng = rng;
  }

  private getOrCreateCategory(category: string): CategoryRouter {
    let categoryRouter = this.categories.get(category);
    if (!categoryRouter) {
      categoryRouter = new CategoryRouter(new Map(), this.rng);
      this.categories.set(category, categoryRouter);
    }
    return categoryRouter;
  }

  /**
   * Declare a candidate model for a task category. Idempotent: if this (category, model) pair
   * is already registered, only its cost is refreshed and learned alpha/beta are left untouched
   * — safe to call repeatedly (e.g. on every registry/config reload) without erasing history.
   * Use resetArm() to deliberately discard learned history, e.g. after a known model swap.
   */
  register(
    category: string,
    modelId: string,
    cost: number,
    priorAlpha = 2,
    priorBeta = 1,
    decay: number = DEFAULT_DECAY
  ): void {
    const categoryRouter = this.getOrCreateCategory(category);
    const existing = categoryRouter.arms.get(modelId);
    if (existing) {
      existing.cost = cost;
      return;
    }
    categoryRouter.arms.set(modelId, new Arm(modelId, cost, priorAlpha, priorBeta, decay));
  }

  /** Deliberately discard learned history for this arm and start over from the given priors. */
  resetArm(
    category: string,
    modelId: string,
    cost: number,
    priorAlpha = 2,
    priorBeta = 1,
    decay: number = DEFAULT_DECAY
  ): void {
    const categoryRouter = this.getOrCreateCategory(category);
    categoryRouter.arms.set(modelId, new Arm(modelId, cost, priorAlpha, priorBeta, decay));
  }

  route(category: string, costWeight = 0): string {
    const categoryRouter = this.categories.get(category);
    if (!categoryRouter) {
      throw new Error(`Unknown category "${category}"`);
    }
    return categoryRouter.select(costWeight);
  }

  /** reward is in [0, 1] — pass 1/0 for a pure success/fail signal, or a blended fraction. */
  reportOutcome(category: string, modelId: string, reward: number): void {
    const categoryRouter = this.categories.get(category);
    if (!categoryRouter) {
      throw new Error(`Unknown category "${category}"`);
    }
    categoryRouter.update(modelId, reward);
  }

  /** Exposed for tests/inspection; not part of the routing API surface. */
  getArm(category: string, modelId: string): Arm | undefined {
    return this.categories.get(category)?.arms.get(modelId);
  }

  /** Current stats for every candidate in a category; empty if the category is unknown. */
  getCandidates(category: string): CandidateStats[] {
    return this.categories.get(category)?.getCandidates() ?? [];
  }
}
