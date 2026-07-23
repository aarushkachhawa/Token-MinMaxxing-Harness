import { describe, expect, it } from "vitest";
import type { ExecutionResult } from "../executor/types.js";
import type { Rng } from "../router/rng.js";
import { fakeCheck, ScriptedJudgeClient } from "./fakes.js";
import { RewardCollector } from "./reward-collector.js";

function makeResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    finalText: "done",
    turns: 1,
    toolCallCount: 0,
    usage: { inputTokens: 10, outputTokens: 5 },
    trace: [],
    stopReason: "final_answer",
    ...overrides,
  };
}

const alwaysSample: Rng = { next: () => 0 };
const neverSample: Rng = { next: () => 1 };

describe("RewardCollector", () => {
  it("uses only the default proxy tier when nothing else is configured", async () => {
    const collector = new RewardCollector();

    const breakdown = await collector.score("do the thing", makeResult());

    expect(breakdown.deterministic).toBeUndefined();
    expect(breakdown.judge).toBeUndefined();
    expect(breakdown.proxy).toBe(1); // clean success on the default fixture
    expect(breakdown.reward).toBe(1);
  });

  it("averages deterministic checks and includes them in the reward", async () => {
    const collector = new RewardCollector({
      deterministicChecks: [fakeCheck("tests", true), fakeCheck("lint", true), fakeCheck("types", false)],
      proxySignals: [],
    });

    const breakdown = await collector.score("task", makeResult());

    expect(breakdown.deterministic).toBeCloseTo(2 / 3, 10);
    expect(breakdown.proxy).toBeUndefined();
    expect(breakdown.reward).toBeCloseTo(2 / 3, 10);
  });

  it("never calls the judge when the sampling roll misses", async () => {
    const judge = new ScriptedJudgeClient([0.9]);
    const collector = new RewardCollector({ judgeClient: judge, rng: neverSample });

    const breakdown = await collector.score("task", makeResult());

    expect(breakdown.judge).toBeUndefined();
    expect(judge.receivedRequests).toHaveLength(0);
  });

  it("calls the judge and folds its score in when the sampling roll hits", async () => {
    const judge = new ScriptedJudgeClient([0.5]);
    const collector = new RewardCollector({
      deterministicChecks: [fakeCheck("tests", true)],
      judgeClient: judge,
      rng: alwaysSample,
    });

    const breakdown = await collector.score("fix the bug", makeResult());

    expect(breakdown.judge).toBe(0.5);
    expect(judge.receivedRequests).toHaveLength(1);
    expect(judge.receivedRequests[0].taskDescription).toBe("fix the bug");

    // deterministic=1, proxy=1 (clean default fixture), judge=0.5, default weights .6/.3/.1
    const expected = (1 * 0.6 + 1 * 0.3 + 0.5 * 0.1) / (0.6 + 0.3 + 0.1);
    expect(breakdown.reward).toBeCloseTo(expected, 10);
  });

  it("re-normalizes weights when a tier is absent instead of treating it as zero", async () => {
    const judge = new ScriptedJudgeClient([0.5]);
    const collector = new RewardCollector({
      deterministicChecks: [fakeCheck("tests", true)],
      proxySignals: [], // explicitly disabled
      judgeClient: judge,
      rng: alwaysSample,
    });

    const breakdown = await collector.score("task", makeResult());

    expect(breakdown.proxy).toBeUndefined();
    const expected = (1 * 0.6 + 0.5 * 0.1) / (0.6 + 0.1);
    expect(breakdown.reward).toBeCloseTo(expected, 10);
  });

  it("throws if no tier is configured to produce a score", async () => {
    const collector = new RewardCollector({ proxySignals: [] });
    await expect(collector.score("task", makeResult())).rejects.toThrow();
  });
});
