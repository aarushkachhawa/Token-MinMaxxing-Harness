export interface BudgetGovernorOptions {
  /** Sliding window over which burn-rate is measured, in ms. Default 60_000 (1 minute). */
  windowMs?: number;
  /** costWeight returned while burn-rate is at or below target. Default 0 (pure quality routing). */
  minLambda?: number;
  /** Hard cap on costWeight regardless of how far burn-rate exceeds target. Default 2. */
  maxLambda?: number;
  /** How aggressively costWeight rises per 100% that burn-rate exceeds target. Default 1. */
  sensitivity?: number;
}

interface SpendEvent {
  timestamp: number;
  tokens: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MIN_LAMBDA = 0;
const DEFAULT_MAX_LAMBDA = 2;
const DEFAULT_SENSITIVITY = 1;

/**
 * Tracks token burn-rate over a sliding window and turns it into a costWeight (lambda) the
 * router can use — rising burn-rate biases routing toward cheaper arms without touching the
 * bandit's learned quality beliefs or overriding the classifier.
 */
export class BudgetGovernor {
  private targetTokensPerMinute: number;
  private windowMs: number;
  private minLambda: number;
  private maxLambda: number;
  private sensitivity: number;
  private events: SpendEvent[] = [];

  constructor(targetTokensPerMinute: number, options: BudgetGovernorOptions = {}) {
    if (targetTokensPerMinute <= 0) {
      throw new Error("targetTokensPerMinute must be positive");
    }
    this.targetTokensPerMinute = targetTokensPerMinute;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.minLambda = options.minLambda ?? DEFAULT_MIN_LAMBDA;
    this.maxLambda = options.maxLambda ?? DEFAULT_MAX_LAMBDA;
    this.sensitivity = options.sensitivity ?? DEFAULT_SENSITIVITY;
  }

  /** Record actual token usage from a completed executor run. */
  recordSpend(inputTokens: number, outputTokens: number, now: number = Date.now()): void {
    this.events.push({ timestamp: now, tokens: inputTokens + outputTokens });
    this.prune(now);
  }

  /** Tokens per minute over the sliding window, as of `now`. */
  getBurnRate(now: number = Date.now()): number {
    this.prune(now);
    const totalTokens = this.events.reduce((sum, event) => sum + event.tokens, 0);
    const windowMinutes = this.windowMs / 60_000;
    return totalTokens / windowMinutes;
  }

  /** The costWeight (lambda) the router should use right now. */
  getCostWeight(now: number = Date.now()): number {
    const burnRate = this.getBurnRate(now);
    if (burnRate <= this.targetTokensPerMinute) {
      return this.minLambda;
    }
    const excessRatio = burnRate / this.targetTokensPerMinute;
    const lambda = this.minLambda + (excessRatio - 1) * this.sensitivity;
    return Math.min(lambda, this.maxLambda);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.events.length > 0 && this.events[0].timestamp < cutoff) {
      this.events.shift();
    }
  }
}
