import { type Rng, shuffle } from './rng';

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** Draws `count` different letters for a match, in round order. */
export function drawLetters(rng: Rng, count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > ALPHABET.length) {
    throw new RangeError(`Letter count must be between 1 and ${ALPHABET.length}, got ${count}`);
  }
  return shuffle(rng, ALPHABET).slice(0, count);
}
