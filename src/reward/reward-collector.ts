import type { ExecutionResult } from "../executor/types.js";
import type { Rng } from "../router/rng.js";
import { SystemRng } from "../router/rng.js";
import { DEFAULT_PROXY_SIGNALS } from "./proxy-signals.js";
import type { DeterministicCheck, JudgeClient, ProxySignal, RewardBreakdown, TierScores } from "./types.js";

export interface RewardWeights {
  deterministic: number;
  proxy: number;
  judge: number;
}

export const DEFAULT_WEIGHTS: RewardWeights = { deterministic: 0.6, proxy: 0.3, judge: 0.1 };
const DEFAULT_JUDGE_SAMPLE_RATE = 0.05;

export interface RewardCollectorOptions {
  /** Real checks (tests pass, lint clean) — omit if none apply to this task. */
  deterministicChecks?: DeterministicCheck[];
  /** Defaults to the built-in trace-based signals; pass [] to disable this tier entirely. */
  proxySignals?: ProxySignal[];
  judgeClient?: JudgeClient;
  judgeSampleRate?: number;
  weights?: RewardWeights;
  /** Injectable so judge-sampling decisions are deterministic in tests. */
  rng?: Rng;
}

/**
 * Turns an ExecutionResult into the [0, 1] reward the router consumes, blending whichever of
 * the three tiers actually ran (a missing tier is dropped, not treated as zero) — see
 * docs/architecture.md's Reward signal section for why they're trusted in this order.
 */
export class RewardCollector {
  private deterministicChecks: DeterministicCheck[];
  private proxySignals: ProxySignal[];
  private judgeClient?: JudgeClient;
  private judgeSampleRate: number;
  private weights: RewardWeights;
  private rng: Rng;

  constructor(options: RewardCollectorOptions = {}) {
    this.deterministicChecks = options.deterministicChecks ?? [];
    this.proxySignals = options.proxySignals ?? DEFAULT_PROXY_SIGNALS;
    this.judgeClient = options.judgeClient;
    this.judgeSampleRate = options.judgeSampleRate ?? DEFAULT_JUDGE_SAMPLE_RATE;
    this.weights = options.weights ?? DEFAULT_WEIGHTS;
    this.rng = options.rng ?? new SystemRng();
  }

  async score(taskDescription: string, result: ExecutionResult): Promise<RewardBreakdown> {
    const scores: TierScores = {};

    if (this.deterministicChecks.length > 0) {
      const outcomes = await Promise.all(this.deterministicChecks.map((check) => check.run(result)));
      scores.deterministic = outcomes.filter(Boolean).length / outcomes.length;
    }

    if (this.proxySignals.length > 0) {
      const values = this.proxySignals.map((signal) => signal.compute(result));
      scores.proxy = values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    if (this.judgeClient && this.rng.next() < this.judgeSampleRate) {
      scores.judge = await this.judgeClient.judge({ taskDescription, result });
    }

    return { ...scores, reward: this.combine(scores) };
  }

  private combine(scores: TierScores): number {
    const present: { value: number; weight: number }[] = [];
    if (scores.deterministic !== undefined) {
      present.push({ value: scores.deterministic, weight: this.weights.deterministic });
    }
    if (scores.proxy !== undefined) {
      present.push({ value: scores.proxy, weight: this.weights.proxy });
    }
    if (scores.judge !== undefined) {
      present.push({ value: scores.judge, weight: this.weights.judge });
    }

    if (present.length === 0) {
      throw new Error("RewardCollector has no signals configured to produce a score");
    }

    const totalWeight = present.reduce((sum, p) => sum + p.weight, 0);
    if (totalWeight === 0) {
      return present.reduce((sum, p) => sum + p.value, 0) / present.length;
    }
    return present.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight;
  }
}
