/**
 * Regenerates src/data/words-tier{1..4}.txt from SCOWL, via the
 * `wordlist-english` npm package (SCOWL size levels as JSON).
 *
 * Usage: npm run wordlist
 *
 * The generated files are committed so that building the game never needs
 * network access. See THIRD_PARTY_NOTICES.md for the word list licence.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIALECTS, TIER_LEVELS, buildTiers } from './wordlist-lib.ts';

const require = createRequire(import.meta.url);
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');

const levels = new Map<number, string[]>();
for (const level of TIER_LEVELS.flat()) {
  const words: string[] = [];
  for (const dialect of DIALECTS) {
    words.push(...(require(`wordlist-english/${dialect}-words-${level}.json`) as string[]));
  }
  levels.set(level, words);
}

mkdirSync(outDir, { recursive: true });
buildTiers(levels).forEach((words, i) => {
  const file = join(outDir, `words-tier${i + 1}.txt`);
  writeFileSync(file, words.join('\n') + '\n');
  console.log(`${relative(process.cwd(), file)}: ${words.length} words (SCOWL levels ${TIER_LEVELS[i]?.join(', ')})`);
});
