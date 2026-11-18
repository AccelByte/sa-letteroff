/**
 * Small seeded random number helpers. Game code takes an `Rng` instead of
 * calling Math.random so that matches are reproducible in tests and, later,
 * on a server.
 */

/** Returns a float in [0, 1). */
export type Rng = () => number;

/** Mulberry32: tiny, fast and good enough for a word game. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derives an independent seed from a base seed and a label, e.g. a round number. */
export function deriveSeed(seed: number, label: number): number {
  let h = (seed ^ Math.imul(label + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Integer in [0, max). */
export function randomInt(rng: Rng, max: number): number {
  return Math.floor(rng() * max);
}

/** Float in [min, max). */
export function randomBetween(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Returns a shuffled copy (Fisher-Yates). */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** A random 32-bit seed for a new match. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32);
}
