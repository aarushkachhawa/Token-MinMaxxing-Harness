import { sampleBeta } from "./beta.js";
import { SystemRng, type Rng } from "./rng.js";

/** One candidate model within a task category. */
export class Arm {
  modelId: string;
  cost: number;
  alpha: number;
  beta: number;

  constructor(modelId: string, cost: number, priorAlpha = 2, priorBeta = 1) {
    this.modelId = modelId;
    this.cost = cost;
    this.alpha = priorAlpha;
    this.beta = priorBeta;
  }

  sample(rng: Rng): number {
    return sampleBeta(this.alpha, this.beta, rng);
  }

  update(success: boolean): void {
    if (success) {
      this.alpha += 1;
    } else {
      this.beta += 1;
    }
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

  /** Draw a sample from each arm's posterior and return the highest cost-adjusted score. */
  select(costWeight = 0): string {
    if (this.arms.size === 0) {
      throw new Error("CategoryRouter has no registered arms");
    }

    let bestModelId: string | null = null;
    let bestScore = -Infinity;
    for (const [modelId, arm] of this.arms) {
      const score = arm.sample(this.rng) - costWeight * arm.cost;
      if (score > bestScore) {
        bestScore = score;
        bestModelId = modelId;
      }
    }
    return bestModelId as string;
  }

  update(modelId: string, success: boolean): void {
    const arm = this.arms.get(modelId);
    if (!arm) {
      throw new Error(`Unknown model "${modelId}" for this category`);
    }
    arm.update(success);
  }
}

/** Per-category Thompson-sampling router across configured worker models. */
export class Router {
  private rng: Rng;
  private categories: Map<string, CategoryRouter> = new Map();

  constructor(rng: Rng = new SystemRng()) {
    this.rng = rng;
  }

  /** Add (or update) a candidate model for a task category. */
  register(category: string, modelId: string, cost: number, priorAlpha = 2, priorBeta = 1): void {
    let categoryRouter = this.categories.get(category);
    if (!categoryRouter) {
      categoryRouter = new CategoryRouter(new Map(), this.rng);
      this.categories.set(category, categoryRouter);
    }
    categoryRouter.arms.set(modelId, new Arm(modelId, cost, priorAlpha, priorBeta));
  }

  route(category: string, costWeight = 0): string {
    const categoryRouter = this.categories.get(category);
    if (!categoryRouter) {
      throw new Error(`Unknown category "${category}"`);
    }
    return categoryRouter.select(costWeight);
  }

  reportOutcome(category: string, modelId: string, success: boolean): void {
    const categoryRouter = this.categories.get(category);
    if (!categoryRouter) {
      throw new Error(`Unknown category "${category}"`);
    }
    categoryRouter.update(modelId, success);
  }

  /** Exposed for tests/inspection; not part of the routing API surface. */
  getArm(category: string, modelId: string): Arm | undefined {
    return this.categories.get(category)?.arms.get(modelId);
  }
}
