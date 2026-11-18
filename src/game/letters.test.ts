import { describe, expect, it } from 'vitest';
import { ALPHABET, drawLetters } from './letters';
import { createRng } from './rng';

describe('drawLetters', () => {
  it('draws the requested number of different letters from A to Z', () => {
    for (const count of [1, 3, 5, 26]) {
      const letters = drawLetters(createRng(count), count);
      expect(letters).toHaveLength(count);
      expect(new Set(letters).size).toBe(count);
      expect(letters.every((l) => ALPHABET.includes(l))).toBe(true);
    }
  });

  it('is reproducible for a seed', () => {
    expect(drawLetters(createRng(5), 5)).toEqual(drawLetters(createRng(5), 5));
  });

  it('rejects impossible counts', () => {
    expect(() => drawLetters(createRng(1), 0)).toThrow(RangeError);
    expect(() => drawLetters(createRng(1), 27)).toThrow(RangeError);
  });
});
