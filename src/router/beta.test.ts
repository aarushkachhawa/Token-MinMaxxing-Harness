import { describe, expect, it } from "vitest";
import { sampleBeta } from "./beta.js";
import { SeededRng } from "./rng.js";

describe("sampleBeta", () => {
  it("draws samples whose empirical mean tracks alpha / (alpha + beta)", () => {
    const rng = new SeededRng(123);
    const alpha = 8;
    const beta = 2;
    const n = 20000;

    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += sampleBeta(alpha, beta, rng);
    }
    const mean = sum / n;

    expect(mean).toBeCloseTo(alpha / (alpha + beta), 1);
  });

  it("stays within [0, 1]", () => {
    const rng = new SeededRng(7);
    for (let i = 0; i < 1000; i++) {
      const sample = sampleBeta(0.5, 3, rng);
      expect(sample).toBeGreaterThanOrEqual(0);
      expect(sample).toBeLessThanOrEqual(1);
    }
  });
});
