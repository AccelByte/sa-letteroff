import { Dictionary, parseWordList } from '../game/dictionary';

/**
 * Loads the bundled word list. The files are imported lazily so the first
 * screen renders before the ~750 KB of words (about 200 KB gzipped) arrives.
 */
export async function loadDictionary(): Promise<Dictionary> {
  const files = await Promise.all([
    import('../data/words-tier1.txt?raw'),
    import('../data/words-tier2.txt?raw'),
    import('../data/words-tier3.txt?raw'),
    import('../data/words-tier4.txt?raw'),
  ]);
  return new Dictionary(files.map((file) => parseWordList(file.default)));
}
