/**
 * Pure helpers for turning SCOWL size-level lists into LetterOff word tiers.
 * Kept separate from build-wordlist.ts so they can be unit tested.
 */

/** SCOWL size levels grouped into LetterOff tiers. Lower levels are more common words. */
export const TIER_LEVELS = [
  [10, 20], // tier 1: common words (the Easy bot knows these)
  [35], // tier 2: everyday vocabulary (Medium)
  [40, 50], // tier 3: less common words (Hard)
  [55, 60], // tier 4: valid for the player, unknown to every bot
] as const;

/** SCOWL dialect lists merged into the dictionary. */
export const DIALECTS = ['english', 'american', 'british'] as const;

const WORD_PATTERN = /^[a-z]{2,}$/;

/** True for plain lowercase a-z words of two or more letters (drops proper nouns, accents, apostrophes). */
export function isPlayableWord(word: string): boolean {
  return WORD_PATTERN.test(word);
}

/**
 * Builds tiers from per-level word lists. Each word lands in the tier of the
 * lowest (most common) level it appears at; tiers are sorted and de-duplicated.
 */
export function buildTiers(levels: ReadonlyMap<number, readonly string[]>): string[][] {
  const seen = new Set<string>();
  return TIER_LEVELS.map((tierLevels) => {
    const tier = new Set<string>();
    for (const level of tierLevels) {
      for (const word of levels.get(level) ?? []) {
        if (isPlayableWord(word) && !seen.has(word)) {
          seen.add(word);
          tier.add(word);
        }
      }
    }
    return [...tier].sort();
  });
}
