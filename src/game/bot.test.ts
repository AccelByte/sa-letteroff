import { describe, expect, it } from 'vitest';
import { BOT_PROFILES, DIFFICULTIES, planBotRound } from './bot';
import { Dictionary } from './dictionary';
import { createRng } from './rng';

const words = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const dict = new Dictionary([
  words('acommon', 200),
  words('aeveryday', 200),
  words('ararer', 200),
  words('aobscure', 200),
]);

const plan = (difficulty: (typeof DIFFICULTIES)[number], roundMs = 60_000, seed = 1) =>
  planBotRound(dict, 'A', difficulty, roundMs, createRng(seed));

describe('planBotRound', () => {
  it('is reproducible for a seed', () => {
    expect(plan('medium', 60_000, 7)).toEqual(plan('medium', 60_000, 7));
  });

  it('plays unique words that start with the letter, in time order, before the round ends', () => {
    for (const difficulty of DIFFICULTIES) {
      const moves = plan(difficulty, 30_000);
      expect(moves.length).toBeGreaterThan(0);
      expect(new Set(moves.map((m) => m.word)).size).toBe(moves.length);
      expect(moves.every((m) => m.word.startsWith('a') && m.atMs >= 0 && m.atMs < 30_000)).toBe(true);
      expect(moves.map((m) => m.atMs)).toEqual([...moves.map((m) => m.atMs)].sort((x, y) => x - y));
    }
  });

  it('respects the first-word delay', () => {
    for (const difficulty of DIFFICULTIES) {
      expect(plan(difficulty)[0]!.atMs).toBeGreaterThanOrEqual(BOT_PROFILES[difficulty].firstWordMs[0]);
    }
  });

  it('only knows the tiers allowed for its difficulty', () => {
    const tiersUsed = (d: (typeof DIFFICULTIES)[number]) => new Set(plan(d, 180_000).map((m) => dict.tierOf(m.word)));
    expect([...tiersUsed('easy')]).toEqual([1]);
    expect([...tiersUsed('medium')].sort()).toEqual([1, 2]);
    expect([...tiersUsed('hard')].sort()).toEqual([1, 2, 3]);
  });

  it('plays faster on harder difficulties', () => {
    const avg = (d: (typeof DIFFICULTIES)[number]) => {
      let total = 0;
      for (let seed = 1; seed <= 20; seed++) total += plan(d, 60_000, seed).length;
      return total / 20;
    };
    expect(avg('easy')).toBeLessThan(avg('medium'));
    expect(avg('medium')).toBeLessThan(avg('hard'));
  });

  it('stops when it runs out of words it knows', () => {
    const tiny = new Dictionary([['xi', 'xis'], ['xylem']]);
    const moves = planBotRound(tiny, 'X', 'easy', 180_000, createRng(1));
    expect(moves.map((m) => m.word).sort()).toEqual(['xi', 'xis']);
  });

  it('plays nothing for a letter it knows no words for', () => {
    expect(planBotRound(dict, 'Z', 'hard', 60_000, createRng(1))).toEqual([]);
  });
});
