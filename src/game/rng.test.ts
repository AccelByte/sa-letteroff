import { describe, expect, it } from 'vitest';
import { createRng, deriveSeed, randomInt, shuffle } from './rng';

describe('rng', () => {
  it('is reproducible for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((n) => n >= 0 && n < 1)).toBe(true);
  });

  it('gives different sequences for different seeds', () => {
    expect(createRng(1)()).not.toEqual(createRng(2)());
  });

  it('derives distinct seeds per label', () => {
    const seeds = new Set([0, 1, 2, 3, 4].map((label) => deriveSeed(7, label)));
    expect(seeds.size).toBe(5);
  });

  it('randomInt stays in range', () => {
    const rng = createRng(3);
    for (let i = 0; i < 1000; i++) {
      const n = randomInt(rng, 6);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(6);
    }
  });

  it('shuffle returns a permutation without changing the input', () => {
    const input = [1, 2, 3, 4, 5, 6];
    const out = shuffle(createRng(9), input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...out].sort()).toEqual(input);
  });
});
