import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALPHABET } from '../game/letters';
import { parseWordList } from '../game/dictionary';

const tiers = [1, 2, 3, 4].map((n) =>
  parseWordList(readFileSync(new URL(`./words-tier${n}.txt`, import.meta.url), 'utf8')),
);

describe('bundled word list', () => {
  it('contains only lowercase a-z words of two or more letters', () => {
    for (const tier of tiers) {
      expect(tier.every((w) => /^[a-z]{2,}$/.test(w))).toBe(true);
    }
  });

  it('has no word in more than one tier', () => {
    const all = tiers.flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('includes everyday words in tier 1', () => {
    for (const word of ['apple', 'house', 'quick', 'zero']) {
      expect(tiers[0]).toContain(word);
    }
  });

  it('has playable words for every letter', () => {
    // X is the thinnest letter (about 20 words), so this is a floor, not a target.
    const all = tiers.flat();
    for (const letter of ALPHABET.map((l) => l.toLowerCase())) {
      expect(all.filter((w) => w.startsWith(letter)).length).toBeGreaterThanOrEqual(15);
    }
  });
});
