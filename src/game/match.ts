/**
 * Match flow as plain data plus pure functions. The caller passes the current
 * time (`now`, in ms) into every function, so the engine never reads a clock
 * and can be driven by a UI timer, a test or, later, a server.
 *
 *   createMatch -> countdown -> playing -> (time up or finishAnswering) -> round-over
 *   round-over -> nextRound -> countdown -> playing ...
 *   the last round ends in finished instead of round-over
 */
import { type BotMove, type Difficulty, planBotRound } from './bot';
import { type Dictionary, type WordCheck, checkWord } from './dictionary';
import { drawLetters } from './letters';
import { createRng, deriveSeed } from './rng';
import { type RoundResult, scoreRound } from './scoring';

export const ROUND_COUNTS = [1, 3, 5] as const;
export const ROUND_SECONDS = [30, 60, 180] as const;
/** Get-ready time before each round's clock starts. */
export const COUNTDOWN_MS = 3000;

export type RoundCount = (typeof ROUND_COUNTS)[number];
export type RoundSeconds = (typeof ROUND_SECONDS)[number];

export interface MatchSettings {
  rounds: RoundCount;
  roundSeconds: RoundSeconds;
  difficulty: Difficulty;
  /** Seed for letters and bot behaviour. Same seed, same match. */
  seed: number;
  /** Countdown before each round, in ms. Defaults to COUNTDOWN_MS. */
  countdownMs?: number;
}

export type Phase = 'countdown' | 'playing' | 'round-over' | 'finished';

export interface MatchState {
  readonly settings: MatchSettings;
  /** When the match was created (ms). Identifies the match in history. */
  readonly startedAt: number;
  readonly letters: readonly string[];
  /** Zero-based index of the current round. */
  readonly roundIndex: number;
  readonly phase: Phase;
  /** When the round clock starts (the end of the countdown). */
  readonly roundStartedAt: number;
  /** Words the player has had accepted this round. */
  readonly playerWords: readonly string[];
  /** The bot's full plan for this round; hidden from the player. */
  readonly botPlan: readonly BotMove[];
  /** How many planned bot moves are due so far (played or skipped). */
  readonly botPlayed: number;
  /**
   * Words the bot actually played this round. A word can only be played once
   * per round, so the bot skips planned words the player already has.
   */
  readonly botWords: readonly string[];
  readonly results: readonly RoundResult[];
}

/**
 * `taken` means the opponent (bot or online player) already played the word
 * this round: each word can only be played once. `pending` (online guest only)
 * means the word is valid and has been sent, but the host hasn't confirmed
 * that the opponent didn't play it first.
 */
export type SubmitResult =
  | WordCheck
  | { ok: true; word: string; pending: true }
  | { ok: false; word: string; reason: 'round-over' | 'not-started' | 'taken' };

export function roundMs(state: MatchState): number {
  return state.settings.roundSeconds * 1000;
}

export function currentLetter(state: MatchState): string {
  return state.letters[state.roundIndex]!;
}

export function timeLeftMs(state: MatchState, now: number): number {
  if (state.phase === 'countdown') return roundMs(state);
  if (state.phase !== 'playing') return 0;
  return Math.max(0, state.roundStartedAt + roundMs(state) - now);
}

/** Time left in the countdown before the round starts; 0 once it has started. */
export function countdownLeftMs(state: MatchState, now: number): number {
  return state.phase === 'countdown' ? Math.max(0, state.roundStartedAt - now) : 0;
}

/** Words the bot has played so far this round. */
export function botWordsSoFar(state: MatchState): string[] {
  return [...state.botWords];
}

export function createMatch(settings: MatchSettings, dictionary: Dictionary, now: number): MatchState {
  const letters = drawLetters(createRng(settings.seed), settings.rounds);
  return startRound(
    {
      settings,
      startedAt: now,
      letters,
      roundIndex: 0,
      phase: 'playing',
      roundStartedAt: now,
      playerWords: [],
      botPlan: [],
      botPlayed: 0,
      botWords: [],
      results: [],
    },
    dictionary,
    0,
    now,
  );
}

function startRound(state: MatchState, dictionary: Dictionary, roundIndex: number, now: number): MatchState {
  const { settings } = state;
  const rng = createRng(deriveSeed(settings.seed, roundIndex));
  const letter = state.letters[roundIndex]!;
  const countdownMs = Math.max(0, settings.countdownMs ?? COUNTDOWN_MS);
  return {
    ...state,
    roundIndex,
    phase: countdownMs > 0 ? 'countdown' : 'playing',
    roundStartedAt: now + countdownMs,
    playerWords: [],
    botPlan: planBotRound(dictionary, letter, settings.difficulty, settings.roundSeconds * 1000, rng),
    botPlayed: 0,
    botWords: [],
  };
}

/** Advances time: starts the round after the countdown, reveals due bot moves and ends the round when time is up. */
export function tick(state: MatchState, now: number): MatchState {
  if (state.phase === 'countdown') {
    if (now < state.roundStartedAt) return state;
    state = { ...state, phase: 'playing' };
  }
  if (state.phase !== 'playing') return state;
  const elapsed = now - state.roundStartedAt;
  let due = state.botPlayed;
  while (due < state.botPlan.length && state.botPlan[due]!.atMs <= elapsed) due++;
  const advanced = playBotMoves(state, due);
  return elapsed >= roundMs(state) ? endRound(advanced) : advanced;
}

/**
 * Plays planned bot moves up to (not including) index `until`, in time order.
 * A move whose word the player already has is skipped, so whoever played a
 * word first keeps it.
 */
function playBotMoves(state: MatchState, until: number): MatchState {
  if (until <= state.botPlayed) return state;
  const taken = new Set(state.playerWords);
  const botWords = [...state.botWords];
  for (const move of state.botPlan.slice(state.botPlayed, until)) {
    if (!taken.has(move.word) && !botWords.includes(move.word)) botWords.push(move.word);
  }
  return { ...state, botPlayed: until, botWords };
}

function endRound(state: MatchState): MatchState {
  const result = scoreRound(currentLetter(state), state.playerWords, state.botWords);
  const isLast = state.roundIndex >= state.letters.length - 1;
  return { ...state, phase: isLast ? 'finished' : 'round-over', results: [...state.results, result] };
}

/** Submits a word for the player. The state only changes if the word is accepted or time ran out. */
export function submitWord(
  state: MatchState,
  dictionary: Dictionary,
  input: string,
  now: number,
): { state: MatchState; result: SubmitResult } {
  const current = tick(state, now);
  if (current.phase !== 'playing') {
    const reason = current.phase === 'countdown' ? 'not-started' : 'round-over';
    return { state: current, result: { ok: false, word: input.trim().toLowerCase(), reason } };
  }
  const result = checkWord(dictionary, currentLetter(current), input, new Set(current.playerWords));
  if (!result.ok) return { state: current, result };
  // tick() above already played every bot move due by now, so this is a fair first-come check.
  if (current.botWords.includes(result.word)) {
    return { state: current, result: { ok: false, word: result.word, reason: 'taken' } };
  }
  return { state: { ...current, playerWords: [...current.playerWords, result.word] }, result };
}

/**
 * Locks the player's words before time runs out. The bot is not cut short:
 * the round is scored as if the clock had run down, so finishing early never
 * changes the bot's words, it only saves the player the wait.
 */
export function finishAnswering(state: MatchState, now: number): MatchState {
  const current = tick(state, now);
  if (current.phase !== 'playing') return current;
  return endRound(playBotMoves(current, current.botPlan.length));
}

/** Starts the next round after a round-over. Does nothing in any other phase. */
export function nextRound(state: MatchState, dictionary: Dictionary, now: number): MatchState {
  if (state.phase !== 'round-over') return state;
  return startRound(state, dictionary, state.roundIndex + 1, now);
}
