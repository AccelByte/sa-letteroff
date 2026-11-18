import { describe, expect, it } from 'vitest';
import { buildTiers, isPlayableWord } from './wordlist-lib.ts';

describe('isPlayableWord', () => {
  it('accepts plain lowercase words of two or more letters', () => {
    expect(isPlayableWord('apple')).toBe(true);
    expect(isPlayableWord('ox')).toBe(true);
  });

  it('rejects single letters, capitals, accents and punctuation', () => {
    for (const word of ['a', 'Paris', 'piñata', "can't", 'e-mail', '']) {
      expect(isPlayableWord(word)).toBe(false);
    }
  });
});

describe('buildTiers', () => {
  it('puts each word in the tier of its most common level, sorted and de-duplicated', () => {
    const levels = new Map<number, string[]>([
      [10, ['cat', 'apple']],
      [20, ['dog', 'cat']],
      [35, ['zebra', 'dog', 'Bob']],
      [50, ['quark']],
      [60, ['zymurgy']],
    ]);
    expect(buildTiers(levels)).toEqual([['apple', 'cat', 'dog'], ['zebra'], ['quark'], ['zymurgy']]);
  });
});
