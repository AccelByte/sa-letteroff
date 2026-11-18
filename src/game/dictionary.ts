/**
 * Word lookup and validation. The dictionary is built from tiers of words,
 * most common first; the bot uses tiers to decide which words it knows.
 */

/** 1 = most common words. The highest tier is valid for the player only. */
export type Tier = 1 | 2 | 3 | 4;

export type Rejection = 'empty' | 'wrong-letter' | 'not-a-word' | 'already-used';

export type WordCheck = { ok: true; word: string } | { ok: false; word: string; reason: Rejection };

export class Dictionary {
  private readonly tiers = new Map<string, Tier>();
  private readonly byLetter = new Map<string, Map<Tier, string[]>>();

  /** `tiers[0]` is tier 1. Words already seen in an earlier tier are ignored. */
  constructor(tiers: readonly (readonly string[])[]) {
    tiers.forEach((words, index) => {
      const tier = (index + 1) as Tier;
      for (const raw of words) {
        const word = normalizeWord(raw);
        if (!word || this.tiers.has(word)) continue;
        this.tiers.set(word, tier);
        const letter = word[0]!.toUpperCase();
        const letterTiers = this.byLetter.get(letter) ?? new Map<Tier, string[]>();
        const list = letterTiers.get(tier) ?? [];
        list.push(word);
        letterTiers.set(tier, list);
        this.byLetter.set(letter, letterTiers);
      }
    });
  }

  get size(): number {
    return this.tiers.size;
  }

  has(word: string): boolean {
    return this.tiers.has(normalizeWord(word));
  }

  tierOf(word: string): Tier | undefined {
    return this.tiers.get(normalizeWord(word));
  }

  /** Words starting with `letter` in exactly the given tier. */
  wordsInTier(letter: string, tier: Tier): readonly string[] {
    return this.byLetter.get(letter.toUpperCase())?.get(tier) ?? [];
  }
}

/** Splits a newline-separated word file into words. */
export function parseWordList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function normalizeWord(input: string): string {
  return input.trim().toLowerCase();
}

/** Checks a submitted word against the round letter, the dictionary and the words already used. */
export function checkWord(dictionary: Dictionary, letter: string, input: string, used: ReadonlySet<string>): WordCheck {
  const word = normalizeWord(input);
  if (!word) return { ok: false, word, reason: 'empty' };
  if (word[0] !== letter.toLowerCase()) return { ok: false, word, reason: 'wrong-letter' };
  if (used.has(word)) return { ok: false, word, reason: 'already-used' };
  if (!dictionary.has(word)) return { ok: false, word, reason: 'not-a-word' };
  return { ok: true, word };
}
