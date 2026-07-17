import { describe, expect, it } from "vitest";
import { BudgetGovernor } from "./budget-governor.js";

describe("BudgetGovernor", () => {
  it("throws for a non-positive target", () => {
    expect(() => new BudgetGovernor(0)).toThrow();
    expect(() => new BudgetGovernor(-10)).toThrow();
  });

  it("returns minLambda with no spend recorded", () => {
    const governor = new BudgetGovernor(1000);
    expect(governor.getBurnRate(0)).toBe(0);
    expect(governor.getCostWeight(0)).toBe(0);
  });

  it("stays at minLambda while burn-rate is at or below target", () => {
    const governor = new BudgetGovernor(1000, { windowMs: 60_000 });
    governor.recordSpend(400, 100, 0); // 500 tokens in a 1-minute window = 500 tokens/min

    expect(governor.getBurnRate(0)).toBe(500);
    expect(governor.getCostWeight(0)).toBe(0);
  });

  it("increases costWeight proportionally once burn-rate exceeds target", () => {
    const governor = new BudgetGovernor(1000, { windowMs: 60_000, sensitivity: 1 });
    governor.recordSpend(1500, 500, 0); // 2000 tokens/min = 2x target

    expect(governor.getBurnRate(0)).toBe(2000);
    // excessRatio = 2, lambda = 0 + (2 - 1) * 1 = 1
    expect(governor.getCostWeight(0)).toBeCloseTo(1, 10);
  });

  it("respects a custom minLambda and sensitivity", () => {
    const governor = new BudgetGovernor(1000, {
      windowMs: 60_000,
      minLambda: 0.2,
      sensitivity: 0.5,
    });
    governor.recordSpend(3000, 0, 0); // 3000 tokens/min = 3x target

    // excessRatio = 3, lambda = 0.2 + (3 - 1) * 0.5 = 1.2
    expect(governor.getCostWeight(0)).toBeCloseTo(1.2, 10);
  });

  it("caps costWeight at maxLambda regardless of how extreme burn-rate gets", () => {
    const governor = new BudgetGovernor(1000, { windowMs: 60_000, maxLambda: 2 });
    governor.recordSpend(1_000_000, 0, 0);

    expect(governor.getCostWeight(0)).toBe(2);
  });

  it("prunes spend once it falls outside the sliding window", () => {
    const governor = new BudgetGovernor(1000, { windowMs: 60_000 });
    governor.recordSpend(5000, 0, 0); // huge spend at t=0

    expect(governor.getBurnRate(30_000)).toBeGreaterThan(0); // still inside the window
    expect(governor.getBurnRate(60_001)).toBe(0); // now outside the window
    expect(governor.getCostWeight(60_001)).toBe(0);
  });

  it("only counts spend within the window, not the full history", () => {
    const governor = new BudgetGovernor(1000, { windowMs: 60_000 });
    governor.recordSpend(2000, 0, 0); // at t=0
    governor.recordSpend(100, 0, 90_000); // at t=90s; t=0 event is now outside the 60s window

    expect(governor.getBurnRate(90_000)).toBe(100);
  });
});
