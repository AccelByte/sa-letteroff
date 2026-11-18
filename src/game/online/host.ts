/**
 * The host's side of an online match. These pure functions move the leader
 * storage through its phases, referee who owns each word, and score each round
 * with the same rules as the bot mode (`checkWord`, `scoreRound`). The host
 * never trusts the guest's word list: it checks every word against the
 * dictionary before accepting it.
 *
 * Each word can only be played once per round. The host's own words are
 * decided as the host types them (`claimHostWord`); the guest's words are
 * decided in the order they reach the host (`acceptGuestClaims`). Whoever's
 * claim the host handles first owns the word.
 */
import { type Dictionary, checkWord } from '../dictionary';
import { COUNTDOWN_MS } from '../match';
import { type RoundResult, scoreRound } from '../scoring';
import {
  type ClockBase,
  type LeaderState,
  type MemberState,
  type OnlineRoundResult,
  type OnlineSettings,
  PROTOCOL_VERSION,
  emptyClaims,
} from './protocol';

/**
 * A round normally ends as soon as both players are finished: each player's
 * game marks them finished when their clock runs out, and that write carries
 * their last words. If the guest's write doesn't arrive (a slow or dropped
 * connection), the host stops waiting this long after the round's end time.
 */
export const END_GRACE_MS = 3000;

export function createLeaderState(settings: OnlineSettings): LeaderState {
  return {
    v: PROTOCOL_VERSION,
    settings,
    phase: 'waiting',
    roundIndex: -1,
    letter: null,
    countdownEndsAt: null,
    roundEndsAt: null,
    clock: 'server',
    results: [],
    claims: emptyClaims(),
  };
}

export function canStartNextRound(state: LeaderState): boolean {
  return (state.phase === 'waiting' || state.phase === 'round-over') && state.roundIndex + 1 < state.settings.rounds;
}

/**
 * Starts the countdown for the next round. The letter and both times are set
 * now, in one write, so the guest has them before the countdown ends and both
 * players start at the same moment. Returns the state unchanged if a round
 * can't start now. `now` and `clock` describe the clock the times are on.
 */
export function startCountdown(
  state: LeaderState,
  now: number,
  letter: string,
  clock: ClockBase = 'server',
  countdownMs = COUNTDOWN_MS,
): LeaderState {
  if (!canStartNextRound(state)) return state;
  const countdownEndsAt = now + countdownMs;
  return {
    ...state,
    phase: 'countdown',
    roundIndex: state.roundIndex + 1,
    letter,
    countdownEndsAt,
    roundEndsAt: countdownEndsAt + state.settings.roundSeconds * 1000,
    clock,
    claims: emptyClaims(),
  };
}

/** Moves to playing once the countdown is over, so word claims are accepted. */
export function startPlaying(state: LeaderState, now: number): LeaderState {
  if (state.phase !== 'countdown' || state.countdownEndsAt === null || now < state.countdownEndsAt) return state;
  return { ...state, phase: 'playing' };
}

/** Words that belong to the current round, from a player's member storage. */
export function wordsForRound(member: MemberState | null, roundIndex: number): string[] {
  return member && member.roundIndex === roundIndex ? member.words : [];
}

export function finishedRound(member: MemberState | null, roundIndex: number): boolean {
  return !!member && member.roundIndex === roundIndex && member.finished;
}

export function shouldEndRound(
  state: LeaderState,
  now: number,
  players: { hostFinished: boolean; guestFinished: boolean },
): boolean {
  if (state.phase !== 'playing' || state.roundEndsAt === null) return false;
  if (players.hostFinished && players.guestFinished) return true;
  return now >= state.roundEndsAt + END_GRACE_MS;
}

/** Keeps only words that are valid for the letter, in order, without repeats. */
export function validWords(dictionary: Dictionary, letter: string, words: readonly string[]): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    const check = checkWord(dictionary, letter, word, used);
    if (check.ok) {
      used.add(check.word);
      out.push(check.word);
    }
  }
  return out;
}

export type HostClaim = { ok: true; state: LeaderState } | { ok: false; reason: 'taken' | 'round-over' };

/**
 * Gives a word the host just played to the host, unless the guest already
 * owns it. The caller has already checked the word against the dictionary and
 * should run `acceptGuestClaims` first, so guest words that arrived earlier win.
 */
export function claimHostWord(state: LeaderState, word: string): HostClaim {
  if (state.phase !== 'playing') return { ok: false, reason: 'round-over' };
  if (state.claims.guest.includes(word)) return { ok: false, reason: 'taken' };
  if (state.claims.host.includes(word)) return { ok: true, state };
  return { ok: true, state: { ...state, claims: { ...state.claims, host: [...state.claims.host, word] } } };
}

/**
 * Decides the guest's new words, in the order the guest played them. A word
 * is accepted if it is valid for the letter and the host doesn't already own
 * it; otherwise it is rejected. Returns the same object if nothing changed.
 */
export function acceptGuestClaims(
  state: LeaderState,
  dictionary: Dictionary,
  guestWords: readonly string[],
): LeaderState {
  if (state.phase !== 'playing' || !state.letter) return state;
  const { host, guest, rejected } = state.claims;
  const decided = new Set([...guest, ...rejected]);
  const owned = new Set([...host, ...guest]);
  const accepted: string[] = [];
  const turnedDown: string[] = [];
  for (const word of guestWords) {
    if (decided.has(word)) continue;
    decided.add(word);
    const valid = checkWord(dictionary, state.letter, word, new Set()).ok;
    if (valid && !owned.has(word)) {
      accepted.push(word);
      owned.add(word);
    } else {
      turnedDown.push(word);
    }
  }
  if (accepted.length === 0 && turnedDown.length === 0) return state;
  return { ...state, claims: { host, guest: [...guest, ...accepted], rejected: [...rejected, ...turnedDown] } };
}

/**
 * Scores the round from the claims and moves to round-over, or finished after
 * the last round. Run `acceptGuestClaims` with the guest's latest words first.
 */
export function endRound(state: LeaderState, dictionary: Dictionary): LeaderState {
  if (state.phase !== 'playing' || !state.letter) return state;
  const letter = state.letter;
  // Claims never overlap, so nothing is shared; the re-check is a guard against bad stored data.
  const scored = scoreRound(
    letter,
    validWords(dictionary, letter, state.claims.host),
    validWords(dictionary, letter, state.claims.guest),
  );
  const result: OnlineRoundResult = {
    letter,
    hostWords: [...scored.playerWords],
    guestWords: [...scored.botWords],
    shared: [...scored.shared],
    hostScore: scored.playerScore,
    guestScore: scored.botScore,
  };
  const isLast = state.roundIndex >= state.settings.rounds - 1;
  return {
    ...state,
    phase: isLast ? 'finished' : 'round-over',
    roundEndsAt: null,
    results: [...state.results, result],
  };
}

/**
 * Turns stored results into the shape the screens use, from one player's point
 * of view: "player" is always this player, "bot" is always the opponent.
 */
export function resultsFor(results: readonly OnlineRoundResult[], role: 'host' | 'guest'): RoundResult[] {
  return results.map((r) =>
    role === 'host'
      ? {
          letter: r.letter,
          playerWords: r.hostWords,
          botWords: r.guestWords,
          shared: r.shared,
          playerScore: r.hostScore,
          botScore: r.guestScore,
        }
      : {
          letter: r.letter,
          playerWords: r.guestWords,
          botWords: r.hostWords,
          shared: r.shared,
          playerScore: r.guestScore,
          botScore: r.hostScore,
        },
  );
}
