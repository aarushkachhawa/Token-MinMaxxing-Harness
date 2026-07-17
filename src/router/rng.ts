export interface Rng {
  next(): number; // uniform in [0, 1)
}

export class SystemRng implements Rng {
  next(): number {
    return Math.random();
  }
}

/** Seedable PRNG (mulberry32) for reproducible simulations and tests. */
export class SeededRng implements Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
