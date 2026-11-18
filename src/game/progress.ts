/**
 * A player's saved progress: the last matches they finished (bot and online),
 * lifetime totals, and their best ranked score for each letter. Plain data and
 * pure functions; where it is stored (localStorage, or the player's private
 * AGS Cloud Save record) is up to the caller.
 *
 * Rankings: only player-vs-player (online) matches count. A match's 60-second
 * rounds also count toward the best score for that round's letter, and the
 * "A–Z best" is the sum of those 26 bests. Bot matches only go to history.
 */
import { HISTORY_LIMIT, type MatchRecord, isMatchRecord } from './history';
import { ALPHABET } from './letters';

export const PROGRESS_VERSION = 1;

/** Only rounds of this length count toward the per-letter bests. */
export const RANKED_ROUND_SECONDS = 60;

/**
 * AGS recommends Cloud Save records stay under 250 KB. Above this size the
 * oldest matches lose their word lists (their scores are kept).
 */
export const PROGRESS_BUDGET_BYTES = 200_000;

export interface ModeTotals {
  played: number;
  wins: number;
  losses: number;
  draws: number;
  /** Points this player scored, and points scored against them. */
  pointsFor: number;
  pointsAgainst: number;
}

export interface LifetimeTotals {
  bot: ModeTotals;
  online: ModeTotals;
  /** Best score in one 60-second online round, per letter. Missing means no ranked round yet. */
  letterBests: Partial<Record<string, number>>;
}

export interface Progress {
  v: typeof PROGRESS_VERSION;
  /** Newest first, at most HISTORY_LIMIT. */
  matches: MatchRecord[];
  /** Every match ever counted, including ones that dropped off `matches`. */
  totals: LifetimeTotals;
  /** IDs of matches already counted in `totals`, so a retried save never counts twice. */
  counted: string[];
}

/** What a finished online match changes on the leaderboards. */
export interface RankingUpdate {
  win: boolean;
  /** This match's best score per letter, from its 60-second rounds only. */
  letterScores: Partial<Record<string, number>>;
}

/** How many match IDs to remember for de-duplication. */
const COUNTED_LIMIT = HISTORY_LIMIT * 2;

export function emptyModeTotals(): ModeTotals {
  return { played: 0, wins: 0, losses: 0, draws: 0, pointsFor: 0, pointsAgainst: 0 };
}

export function emptyProgress(): Progress {
  return {
    v: PROGRESS_VERSION,
    matches: [],
    totals: { bot: emptyModeTotals(), online: emptyModeTotals(), letterBests: {} },
    counted: [],
  };
}

/** Online matches count toward rankings; bot matches only go to history. */
export function isRanked(record: MatchRecord): boolean {
  return record.mode === 'online';
}

/** This match's best score per letter from its 60-second rounds (ranked matches only). */
export function rankedLetterScores(record: MatchRecord): Partial<Record<string, number>> {
  const scores: Partial<Record<string, number>> = {};
  if (!isRanked(record) || record.roundSeconds !== RANKED_ROUND_SECONDS) return scores;
  for (const round of record.results) {
    const letter = round.letter.toUpperCase();
    if (!ALPHABET.includes(letter)) continue;
    scores[letter] = Math.max(scores[letter] ?? 0, round.playerScore);
  }
  return scores;
}

/** The leaderboard changes for a finished match, or null if it doesn't count (bot match). */
export function rankingUpdate(record: MatchRecord): RankingUpdate | null {
  if (!isRanked(record)) return null;
  return { win: record.winner === 'player', letterScores: rankedLetterScores(record) };
}

/** Keeps the higher score for each letter. */
export function mergeBests(
  bests: Partial<Record<string, number>>,
  scores: Partial<Record<string, number>>,
): Partial<Record<string, number>> {
  const merged = { ...bests };
  for (const [letter, score] of Object.entries(scores)) {
    if (score !== undefined) merged[letter] = Math.max(merged[letter] ?? 0, score);
  }
  return merged;
}

/** The "A–Z best": the sum of the best score for each letter. */
export function sumBests(bests: Partial<Record<string, number>>): number {
  return ALPHABET.reduce((sum, letter) => sum + (bests[letter] ?? 0), 0);
}

function addToTotals(totals: ModeTotals, record: MatchRecord): ModeTotals {
  return {
    played: totals.played + 1,
    wins: totals.wins + (record.winner === 'player' ? 1 : 0),
    losses: totals.losses + (record.winner === 'bot' ? 1 : 0),
    draws: totals.draws + (record.winner === 'draw' ? 1 : 0),
    pointsFor: totals.pointsFor + record.playerTotal,
    pointsAgainst: totals.pointsAgainst + record.botTotal,
  };
}

/**
 * Adds a finished match: to the front of the list (keeping the last
 * HISTORY_LIMIT) and to the lifetime totals. Adding the same match again
 * changes nothing.
 */
export function addMatch(progress: Progress, record: MatchRecord): Progress {
  if (progress.counted.includes(record.id) || progress.matches.some((m) => m.id === record.id)) return progress;
  const mode = isRanked(record) ? 'online' : 'bot';
  return {
    ...progress,
    matches: [record, ...progress.matches].slice(0, HISTORY_LIMIT),
    totals: {
      ...progress.totals,
      [mode]: addToTotals(progress.totals[mode], record),
      letterBests: mergeBests(progress.totals.letterBests, rankedLetterScores(record)),
    },
    counted: [record.id, ...progress.counted].slice(0, COUNTED_LIMIT),
  };
}

/** Clears the match list. Lifetime totals and letter bests are kept. */
export function clearMatches(progress: Progress): Progress {
  return { ...progress, matches: [] };
}

/** Combined totals across bot and online matches. */
export function overallTotals(totals: LifetimeTotals): ModeTotals {
  const keys = Object.keys(emptyModeTotals()) as (keyof ModeTotals)[];
  return Object.fromEntries(keys.map((k) => [k, totals.bot[k] + totals.online[k]])) as unknown as ModeTotals;
}

export function progressSize(progress: Progress): number {
  return new TextEncoder().encode(JSON.stringify(progress)).length;
}

/**
 * Keeps the saved progress under `maxBytes` by dropping the word lists of the
 * oldest matches first. Scores, letters and totals are always kept.
 */
export function fitToBudget(progress: Progress, maxBytes = PROGRESS_BUDGET_BYTES): Progress {
  if (progressSize(progress) <= maxBytes) return progress;
  const matches = [...progress.matches];
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    if (m.trimmed) continue;
    matches[i] = {
      ...m,
      trimmed: true,
      results: m.results.map((r) => ({ ...r, playerWords: [], botWords: [], shared: [] })),
    };
    if (progressSize({ ...progress, matches }) <= maxBytes) break;
  }
  return { ...progress, matches };
}

/** Builds progress from an existing list of matches (for example the old localStorage history). */
export function progressFromMatches(matches: readonly MatchRecord[]): Progress {
  return [...matches].reverse().reduce(addMatch, emptyProgress());
}

// ---------- Reading stored data ----------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

function parseModeTotals(v: unknown): ModeTotals | null {
  if (!isObject(v)) return null;
  const t = emptyModeTotals();
  for (const key of Object.keys(t) as (keyof ModeTotals)[]) {
    if (!isCount(v[key])) return null;
    t[key] = v[key] as number;
  }
  return t;
}

function parseBests(v: unknown): Partial<Record<string, number>> {
  const bests: Partial<Record<string, number>> = {};
  if (!isObject(v)) return bests;
  for (const letter of ALPHABET) if (isCount(v[letter])) bests[letter] = v[letter] as number;
  return bests;
}

/**
 * Reads stored progress. Malformed matches are dropped; if the totals are
 * missing or malformed they are rebuilt from the matches. Returns null for
 * anything that isn't progress at all.
 */
export function parseProgress(v: unknown): Progress | null {
  if (!isObject(v) || v.v !== PROGRESS_VERSION || !Array.isArray(v.matches)) return null;
  const matches = v.matches.filter(isMatchRecord).slice(0, HISTORY_LIMIT);
  const t = isObject(v.totals) ? v.totals : null;
  const bot = parseModeTotals(t?.bot);
  const online = parseModeTotals(t?.online);
  if (!bot || !online) return progressFromMatches(matches);
  const counted = Array.isArray(v.counted) ? v.counted.filter((id): id is string => typeof id === 'string') : [];
  return {
    v: PROGRESS_VERSION,
    matches,
    totals: { bot, online, letterBests: parseBests(t?.letterBests) },
    counted: [...new Set([...counted, ...matches.map((m) => m.id)])].slice(0, COUNTED_LIMIT),
  };
}
