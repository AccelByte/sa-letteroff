import { describe, expect, it } from 'vitest';
import { Dictionary, checkWord, parseWordList } from './dictionary';

const dict = new Dictionary([['apple', 'ant', 'bee'], ['axe', 'apple'], ['aardvark'], ['abaci']]);

describe('Dictionary', () => {
  it('looks words up case-insensitively and reports their tier', () => {
    expect(dict.has('Apple')).toBe(true);
    expect(dict.has('zebra')).toBe(false);
    expect(dict.tierOf('apple')).toBe(1); // first tier wins
    expect(dict.tierOf('axe')).toBe(2);
    expect(dict.tierOf('abaci')).toBe(4);
    expect(dict.size).toBe(6);
  });

  it('lists words by letter and tier', () => {
    expect(dict.wordsInTier('a', 1)).toEqual(['apple', 'ant']);
    expect(dict.wordsInTier('A', 3)).toEqual(['aardvark']);
    expect(dict.wordsInTier('Q', 1)).toEqual([]);
  });
});

describe('parseWordList', () => {
  it('splits lines and drops blanks, including Windows line endings', () => {
    expect(parseWordList('apple\r\nant\n\n bee \n')).toEqual(['apple', 'ant', 'bee']);
  });
});

describe('checkWord', () => {
  const used = new Set(['ant']);

  it('accepts a valid new word and normalises it', () => {
    expect(checkWord(dict, 'A', '  APPLE ', used)).toEqual({ ok: true, word: 'apple' });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['bee', 'wrong-letter'],
    ['ant', 'already-used'],
    ['Ant', 'already-used'],
    ['azzzz', 'not-a-word'],
  ])('rejects %j as %s', (input, reason) => {
    expect(checkWord(dict, 'a', input, used)).toMatchObject({ ok: false, reason });
  });
});
