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

/** A cache-read token bills at roughly 10% of a fresh input token's price on Anthropic. */
const CACHE_READ_WEIGHT = 0.1;
/** A cache-write token bills at a premium over a fresh input token (1.25x-2x depending on TTL);
 * this is a single shared, conservative estimate rather than threading TTL through here too --
 * writes are typically a small minority of a run's total input tokens next to the reads they
 * enable, so the exact write weight matters far less than getting the (dominant) read discount
 * right. */
const CACHE_WRITE_WEIGHT = 1.5;

export interface CacheTokenBreakdown {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

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

  /**
   * Record actual token usage from a completed executor run. `inputTokens` is the total prompt
   * token count (cache reads/writes already included in it, matching how the Anthropic usage
   * object itself reports it) -- `cacheTokens` breaks out how much of that total was served from
   * cache so burn-rate reflects real spend instead of raw token volume. Without this, a call that
   * hits a full cache read would count as if it cost the same as a completely fresh call, even
   * though it billed at a fraction of the price -- caching would then never show up as the harness
   * actually getting cheaper, and the budget governor's cost-weight dial would keep biasing routing
   * toward cheaper arms even after caching had already done that job for free.
   */
  recordSpend(
    inputTokens: number,
    outputTokens: number,
    now: number = Date.now(),
    cacheTokens: CacheTokenBreakdown = {}
  ): void {
    const cacheReadTokens = cacheTokens.cacheReadTokens ?? 0;
    const cacheWriteTokens = cacheTokens.cacheWriteTokens ?? 0;
    const freshInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
    const billedTokens =
      freshInputTokens +
      cacheReadTokens * CACHE_READ_WEIGHT +
      cacheWriteTokens * CACHE_WRITE_WEIGHT +
      outputTokens;
    this.events.push({ timestamp: now, tokens: billedTokens });
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
