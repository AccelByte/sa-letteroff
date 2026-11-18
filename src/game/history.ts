/**
 * Match history records: how a finished match is summarised, capped and
 * (de)serialised. Storage lives elsewhere (localStorage or AGS Cloud Save,
 * see progress.ts), so this module only deals with the data.
 */
import { DIFFICULTIES, type Difficulty } from './bot';
import { type MatchState, ROUND_COUNTS, ROUND_SECONDS, type RoundCount, type RoundSeconds } from './match';
import { displayName } from './player';
import { type Outcome, type RoundResult, matchTotals } from './scoring';

export const HISTORY_LIMIT = 100;
export const HISTORY_VERSION = 1;

export interface MatchRecord {
  /** Unique per match: start time plus seed. */
  id: string;
  /** ISO 8601 time the match ended. */
  playedAt: string;
  playerName: string;
  rounds: RoundCount;
  roundSeconds: RoundSeconds;
  /** Bot level; only for matches against the bot. */
  difficulty?: Difficulty;
  /** Missing on records saved before online play existed, which were all bot matches. */
  mode?: 'bot' | 'online';
  /** Online matches only. */
  opponentName?: string;
  seed: number;
  results: RoundResult[];
  playerTotal: number;
  botTotal: number;
  winner: Outcome;
  /** Set when the word lists were dropped to keep the saved history small. Scores are kept. */
  trimmed?: true;
}

interface StoredHistory {
  version: typeof HISTORY_VERSION;
  matches: MatchRecord[];
}

/** Builds a record from a finished match. Returns null if the match isn't finished. */
export function createRecord(match: MatchState, playerName: string, now: number): MatchRecord | null {
  if (match.phase !== 'finished') return null;
  const totals = matchTotals(match.results);
  return {
    id: `${match.startedAt}-${match.settings.seed}`,
    playedAt: new Date(now).toISOString(),
    playerName: displayName(playerName),
    rounds: match.settings.rounds,
    roundSeconds: match.settings.roundSeconds,
    difficulty: match.settings.difficulty,
    mode: 'bot',
    seed: match.settings.seed,
    results: match.results.map((r) => ({
      ...r,
      playerWords: [...r.playerWords],
      botWords: [...r.botWords],
      shared: [...r.shared],
    })),
    playerTotal: totals.player,
    botTotal: totals.bot,
    winner: totals.winner,
  };
}

export interface OnlineRecordInput {
  /** Unique per match, e.g. the session ID. */
  id: string;
  playerName: string;
  opponentName: string;
  rounds: RoundCount;
  roundSeconds: RoundSeconds;
  results: readonly RoundResult[];
}

/** Builds a record for a finished online match. Results are from this player's point of view. */
export function createOnlineRecord(input: OnlineRecordInput, now: number): MatchRecord {
  const totals = matchTotals(input.results);
  return {
    id: `online-${input.id}`,
    playedAt: new Date(now).toISOString(),
    playerName: displayName(input.playerName),
    rounds: input.rounds,
    roundSeconds: input.roundSeconds,
    mode: 'online',
    opponentName: input.opponentName,
    seed: 0,
    results: input.results.map((r) => ({
      ...r,
      playerWords: [...r.playerWords],
      botWords: [...r.botWords],
      shared: [...r.shared],
    })),
    playerTotal: totals.player,
    botTotal: totals.bot,
    winner: totals.winner,
  };
}

/** Adds a record to the front, ignoring duplicates, keeping at most `limit` records. */
export function addRecord(history: readonly MatchRecord[], record: MatchRecord, limit = HISTORY_LIMIT): MatchRecord[] {
  if (history.some((r) => r.id === record.id)) return [...history];
  return [record, ...history].slice(0, limit);
}

export interface HistoryStats {
  played: number;
  wins: number;
  losses: number;
  draws: number;
}

export function historyStats(history: readonly MatchRecord[]): HistoryStats {
  return {
    played: history.length,
    wins: history.filter((r) => r.winner === 'player').length,
    losses: history.filter((r) => r.winner === 'bot').length,
    draws: history.filter((r) => r.winner === 'draw').length,
  };
}

export function serializeHistory(history: readonly MatchRecord[]): string {
  const stored: StoredHistory = { version: HISTORY_VERSION, matches: [...history] };
  return JSON.stringify(stored);
}

/**
 * Reads stored history. Anything unreadable gives an empty list, and records
 * that don't have the expected shape are dropped rather than crashing the app.
 */
export function parseHistory(raw: string | null): MatchRecord[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isObject(data) || data.version !== HISTORY_VERSION || !Array.isArray(data.matches)) return [];
  return data.matches.filter(isMatchRecord).slice(0, HISTORY_LIMIT);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

function isRoundResult(v: unknown): v is RoundResult {
  return (
    isObject(v) &&
    typeof v.letter === 'string' &&
    isStringArray(v.playerWords) &&
    isStringArray(v.botWords) &&
    isStringArray(v.shared) &&
    isCount(v.playerScore) &&
    isCount(v.botScore)
  );
}

/** True if a stored value has the shape of a match record. */
export function isMatchRecord(v: unknown): v is MatchRecord {
  return (
    isObject(v) &&
    typeof v.id === 'string' &&
    typeof v.playedAt === 'string' &&
    !Number.isNaN(Date.parse(v.playedAt)) &&
    typeof v.playerName === 'string' &&
    (ROUND_COUNTS as readonly unknown[]).includes(v.rounds) &&
    (ROUND_SECONDS as readonly unknown[]).includes(v.roundSeconds) &&
    (v.mode === 'online'
      ? typeof v.opponentName === 'string' &&
        (v.difficulty === undefined || DIFFICULTIES.includes(v.difficulty as Difficulty))
      : (v.mode === undefined || v.mode === 'bot') && (DIFFICULTIES as readonly unknown[]).includes(v.difficulty)) &&
    typeof v.seed === 'number' &&
    Array.isArray(v.results) &&
    v.results.length > 0 &&
    v.results.every(isRoundResult) &&
    isCount(v.playerTotal) &&
    isCount(v.botTotal) &&
    (v.winner === 'player' || v.winner === 'bot' || v.winner === 'draw') &&
    (v.trimmed === undefined || v.trimmed === true)
  );
}
