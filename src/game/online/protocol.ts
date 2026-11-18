/**
 * Shared state for an online match, stored in an AGS Session V2 game session
 * (or the mock backend, which copies its rules).
 *
 * - Leader storage: written only by the host (the session leader). Holds the
 *   match settings, phase, current letter, timers, round results and who owns
 *   each word played this round (`claims`).
 * - Member storage: each player writes only their own. Holds their name and
 *   the words they have tried to play this round.
 *
 * Each word can only be played once per round. The host is the referee: it
 * decides its own words straight away and handles the guest's words in the
 * order they arrive, so if both play the same word at nearly the same time,
 * exactly one of them gets it and both see the same answer.
 *
 * Each storage write replaces the whole object, so writers always send the
 * full state. Everything read back is validated, because it comes from the
 * other player's browser.
 */
import { ROUND_COUNTS, ROUND_SECONDS, type RoundCount, type RoundSeconds } from '../match';

/** Bumped when the stored format changes; also used as the matchmaking `protocol` attribute. */
export const PROTOCOL_VERSION = 4;

/** Settings used for Quick match, where nobody picks them. */
export const QUICK_MATCH_SETTINGS: OnlineSettings = { rounds: 3, roundSeconds: 60 };

export const MAX_WORDS_PER_ROUND = 500;
const MAX_WORD_LENGTH = 40;
const MAX_NAME_LENGTH = 20;

export type OnlinePhase = 'waiting' | 'countdown' | 'playing' | 'round-over' | 'finished';

export interface OnlineSettings {
  rounds: RoundCount;
  roundSeconds: RoundSeconds;
}

export interface OnlineRoundResult {
  letter: string;
  hostWords: string[];
  guestWords: string[];
  shared: string[];
  hostScore: number;
  guestScore: number;
}

/** Who owns which word in the current round. Decided by the host; the two lists never overlap. */
export interface RoundClaims {
  host: string[];
  guest: string[];
  /** Words the guest tried to play that the host already had (or that weren't valid). */
  rejected: string[];
}

export type ClockBase = 'server' | 'host';

export interface LeaderState {
  v: typeof PROTOCOL_VERSION;
  settings: OnlineSettings;
  phase: OnlinePhase;
  /** Zero-based; -1 before the first round. */
  roundIndex: number;
  /**
   * Written together with the countdown, so it has reached the guest by the
   * time the countdown ends. Both screens keep it hidden until `countdownEndsAt`.
   */
  letter: string | null;
  /** When the letter is revealed and the round clock starts, and when the round ends (ms, see `clock`). */
  countdownEndsAt: number | null;
  roundEndsAt: number | null;
  /**
   * `server`: the times are on the backend's clock, which both players have
   * measured their offset from, so both reveal the letter and end the round
   * at the same moment. `host`: the host couldn't read the server clock, so
   * the times are on its own clock and the guest times each phase from when
   * it sees it instead.
   */
  clock: ClockBase;
  results: OnlineRoundResult[];
  /** Word ownership for the round at `roundIndex`. */
  claims: RoundClaims;
}

export interface MemberState {
  v: typeof PROTOCOL_VERSION;
  name: string;
  /** The round these words belong to; words from an earlier round are ignored. */
  roundIndex: number;
  /**
   * For the guest, every word it has claimed this round, in order, including
   * ones the host hasn't decided yet or turned down. For the host, its own words.
   */
  words: string[];
  /** Set when this player is done with the round: they pressed Finish answering, or their clock ran out. */
  finished: boolean;
  /**
   * How many round results this player has seen. The host waits for the
   * guest to have seen the last round's result before the next countdown,
   * so the guest never misses the summary.
   */
  seenResults: number;
}

// ---------- Session snapshot (what a backend returns) ----------

/** AGS Session V2 member statuses (statusV2). Unknown strings are treated as "gone". */
export type MemberStatus =
  | 'INVITED'
  | 'JOINED'
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'LEFT'
  | 'KICKED'
  | 'DROPPED'
  | 'TERMINATED'
  | 'REJECTED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | (string & {});

export interface SessionMember {
  userId: string;
  status: MemberStatus;
}

export interface SessionSnapshot {
  id: string;
  code: string | null;
  leaderId: string;
  members: SessionMember[];
  leaderStorage: unknown;
  memberStorage: Record<string, unknown>;
}

export type Presence = 'present' | 'reconnecting' | 'gone';

export function presenceOf(status: MemberStatus): Presence {
  if (status === 'JOINED' || status === 'CONNECTED') return 'present';
  if (status === 'DISCONNECTED' || status === 'INVITED') return 'reconnecting';
  return 'gone';
}

// ---------- Validation ----------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min;
const isTime = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
const isLetter = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]$/.test(v);
const PHASES: readonly OnlinePhase[] = ['waiting', 'countdown', 'playing', 'round-over', 'finished'];

function cleanWords(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const words = v
    .filter((w): w is string => typeof w === 'string')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0 && w.length <= MAX_WORD_LENGTH);
  return [...new Set(words)].slice(0, MAX_WORDS_PER_ROUND);
}

function parseResult(v: unknown): OnlineRoundResult | null {
  if (!isObject(v) || !isLetter(v.letter) || !isInt(v.hostScore) || !isInt(v.guestScore)) return null;
  const hostWords = cleanWords(v.hostWords);
  const guestWords = cleanWords(v.guestWords);
  const shared = cleanWords(v.shared);
  if (!hostWords || !guestWords || !shared) return null;
  return { letter: v.letter, hostWords, guestWords, shared, hostScore: v.hostScore, guestScore: v.guestScore };
}

/** Reads leader storage. Returns null if it is empty or not in the expected shape. */
export function parseLeaderState(v: unknown): LeaderState | null {
  if (!isObject(v) || v.v !== PROTOCOL_VERSION || !isObject(v.settings)) return null;
  const { rounds, roundSeconds } = v.settings;
  if (!(ROUND_COUNTS as readonly unknown[]).includes(rounds)) return null;
  if (!(ROUND_SECONDS as readonly unknown[]).includes(roundSeconds)) return null;
  if (!PHASES.includes(v.phase as OnlinePhase)) return null;
  if (!isInt(v.roundIndex, -1) || (v.roundIndex as number) >= (rounds as number)) return null;
  if (!(v.letter === null || isLetter(v.letter))) return null;
  if (!isTime(v.countdownEndsAt) || !isTime(v.roundEndsAt)) return null;
  if (v.clock !== 'server' && v.clock !== 'host') return null;
  if (!Array.isArray(v.results) || !isObject(v.claims)) return null;
  const claims = {
    host: cleanWords(v.claims.host),
    guest: cleanWords(v.claims.guest),
    rejected: cleanWords(v.claims.rejected),
  };
  if (!claims.host || !claims.guest || !claims.rejected) return null;
  const results = v.results.map(parseResult);
  if (results.some((r) => r === null) || results.length > (rounds as number)) return null;
  return {
    v: PROTOCOL_VERSION,
    settings: { rounds: rounds as RoundCount, roundSeconds: roundSeconds as RoundSeconds },
    phase: v.phase as OnlinePhase,
    roundIndex: v.roundIndex as number,
    letter: v.letter as string | null,
    countdownEndsAt: v.countdownEndsAt as number | null,
    roundEndsAt: v.roundEndsAt as number | null,
    clock: v.clock,
    results: results as OnlineRoundResult[],
    claims: claims as RoundClaims,
  };
}

/** Reads a player's member storage. Returns null if it is empty or malformed. */
export function parseMemberState(v: unknown): MemberState | null {
  if (!isObject(v) || v.v !== PROTOCOL_VERSION || typeof v.name !== 'string') return null;
  if (!isInt(v.roundIndex, -1) || typeof v.finished !== 'boolean' || !isInt(v.seenResults)) return null;
  const words = cleanWords(v.words);
  if (!words) return null;
  const name = [...v.name.replace(/\s+/g, ' ').trim()].slice(0, MAX_NAME_LENGTH).join('');
  return {
    v: PROTOCOL_VERSION,
    name,
    roundIndex: v.roundIndex,
    words,
    finished: v.finished,
    seenResults: v.seenResults,
  };
}

export function emptyClaims(): RoundClaims {
  return { host: [], guest: [], rejected: [] };
}

export function memberState(
  name: string,
  roundIndex: number,
  words: readonly string[],
  finished: boolean,
  seenResults = 0,
): MemberState {
  return { v: PROTOCOL_VERSION, name, roundIndex, words: [...words], finished, seenResults };
}
