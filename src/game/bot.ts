/**
 * The bot opponent. At the start of each round the bot plans every word it
 * will play and when, so its behaviour is a pure function of the dictionary,
 * letter, difficulty, round length and random seed. The match engine reveals
 * planned moves as time passes.
 */
import type { Dictionary, Tier } from './dictionary';
import { type Rng, randomBetween, randomInt } from './rng';

export type Difficulty = 'easy' | 'medium' | 'hard';

export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

export interface BotProfile {
  /** Delay before the first word, in ms: [min, max). */
  firstWordMs: readonly [number, number];
  /** Gap between words, in ms: [min, max). */
  gapMs: readonly [number, number];
  /** How likely the bot is to reach for a word from each tier it knows. */
  tierWeights: Partial<Record<Tier, number>>;
}

export const BOT_PROFILES: Record<Difficulty, BotProfile> = {
  easy: { firstWordMs: [3000, 5000], gapMs: [4000, 7000], tierWeights: { 1: 1 } },
  medium: { firstWordMs: [2000, 3500], gapMs: [2500, 4500], tierWeights: { 1: 0.65, 2: 0.35 } },
  hard: { firstWordMs: [1200, 2200], gapMs: [1400, 2800], tierWeights: { 1: 0.45, 2: 0.35, 3: 0.2 } },
};

export interface BotMove {
  word: string;
  /** Milliseconds after the round started. */
  atMs: number;
}

/** Plans the bot's words for one round. Moves are in time order and all land before the round ends. */
export function planBotRound(
  dictionary: Dictionary,
  letter: string,
  difficulty: Difficulty,
  roundMs: number,
  rng: Rng,
): BotMove[] {
  const profile = BOT_PROFILES[difficulty];
  const pools = new Map<Tier, string[]>();
  for (const key of Object.keys(profile.tierWeights)) {
    const tier = Number(key) as Tier;
    pools.set(tier, [...dictionary.wordsInTier(letter, tier)]);
  }

  const moves: BotMove[] = [];
  let at = randomBetween(rng, ...profile.firstWordMs);
  while (at < roundMs) {
    const word = takeWord(pools, profile.tierWeights, rng);
    if (!word) break; // the bot has run out of words it knows
    moves.push({ word, atMs: Math.round(at) });
    at += randomBetween(rng, ...profile.gapMs);
  }
  return moves.filter((m) => m.atMs < roundMs);
}

/** Picks a tier by weight among tiers that still have words, then removes and returns a random word from it. */
function takeWord(pools: Map<Tier, string[]>, weights: BotProfile['tierWeights'], rng: Rng): string | undefined {
  const available = [...pools].filter(([, words]) => words.length > 0);
  const total = available.reduce((sum, [tier]) => sum + (weights[tier] ?? 0), 0);
  if (available.length === 0 || total <= 0) return undefined;

  let roll = rng() * total;
  for (const [tier, words] of available) {
    roll -= weights[tier] ?? 0;
    if (roll < 0) return words.splice(randomInt(rng, words.length), 1)[0];
  }
  const last = available[available.length - 1]![1];
  return last.splice(randomInt(rng, last.length), 1)[0];
}
