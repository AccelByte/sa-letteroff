import { describe, expect, it } from 'vitest';
import { Dictionary } from '../dictionary';
import {
  END_GRACE_MS,
  acceptGuestClaims,
  canStartNextRound,
  claimHostWord,
  createLeaderState,
  endRound,
  finishedRound,
  resultsFor,
  shouldEndRound,
  startCountdown,
  startPlaying,
  validWords,
  wordsForRound,
} from './host';
import { type LeaderState, memberState } from './protocol';

const dict = new Dictionary([['apple', 'ant', 'axe', 'arm', 'bee', 'bear']]);
const T0 = 1_000_000;

function playingState(rounds: 1 | 3 = 3) {
  const s0 = createLeaderState({ rounds, roundSeconds: 30 });
  const s1 = startCountdown(s0, T0, 'A');
  return startPlaying(s1, T0 + 3000);
}

/** Plays host words, then guest words, through the referee functions. */
function withClaims(state: LeaderState, hostWords: string[], guestWords: string[]): LeaderState {
  let s = state;
  for (const word of hostWords) {
    const claim = claimHostWord(s, word);
    if (claim.ok) s = claim.state;
  }
  return acceptGuestClaims(s, dict, guestWords);
}

describe('round flow', () => {
  it('sets the letter and both times with the countdown, then starts playing when it ends', () => {
    const s0 = createLeaderState({ rounds: 3, roundSeconds: 30 });
    const s1 = startCountdown(s0, T0, 'A');
    expect(s1).toMatchObject({
      phase: 'countdown',
      roundIndex: 0,
      letter: 'A',
      countdownEndsAt: T0 + 3000,
      roundEndsAt: T0 + 3000 + 30_000,
      clock: 'server',
    });
    expect(startPlaying(s1, T0 + 2999)).toBe(s1); // too early
    const s2 = startPlaying(s1, T0 + 3000);
    expect(s2).toMatchObject({ phase: 'playing', letter: 'A', roundEndsAt: T0 + 3000 + 30_000 });
    expect(startCountdown(s0, T0, 'B', 'host').clock).toBe('host');
  });

  it('only starts a round from waiting or round-over', () => {
    const s = playingState();
    expect(canStartNextRound(s)).toBe(false);
    expect(startCountdown(s, T0, 'B')).toBe(s);
  });

  it('ends a round when both players finish, or after the clock plus a grace period', () => {
    const s = playingState();
    const end = s.roundEndsAt!;
    expect(shouldEndRound(s, end - 1, { hostFinished: true, guestFinished: false })).toBe(false);
    expect(shouldEndRound(s, end - 1, { hostFinished: true, guestFinished: true })).toBe(true);
    expect(shouldEndRound(s, end + END_GRACE_MS - 1, { hostFinished: false, guestFinished: false })).toBe(false);
    expect(shouldEndRound(s, end + END_GRACE_MS, { hostFinished: false, guestFinished: false })).toBe(true);
  });

  it('scores each player for the words they own', () => {
    const s = endRound(withClaims(playingState(), ['apple', 'ant'], ['ant', 'axe', 'bee', 'zzz', 'arm']), dict);
    expect(s.phase).toBe('round-over');
    expect(s.results[0]).toEqual({
      letter: 'A',
      hostWords: ['apple', 'ant'],
      guestWords: ['axe', 'arm'],
      shared: [],
      hostScore: 2,
      guestScore: 2,
    });
  });

  it('finishes after the last round', () => {
    expect(endRound(playingState(1), dict).phase).toBe('finished');
  });

  it('starts every round with no claims', () => {
    let s = endRound(withClaims(playingState(), ['apple'], ['axe']), dict);
    s = startCountdown(s, T0 + 40_000, 'B');
    expect(s.claims).toEqual({ host: [], guest: [], rejected: [] });
  });

  it('plays three rounds back to back', () => {
    let s = createLeaderState({ rounds: 3, roundSeconds: 30 });
    let t = T0;
    for (const letter of ['A', 'B', 'A']) {
      s = startCountdown(s, t, letter);
      t += 3000;
      s = startPlaying(s, t);
      t += 31_500;
      s = endRound(s, dict);
    }
    expect(s.phase).toBe('finished');
    expect(s.results.map((r) => r.letter)).toEqual(['A', 'B', 'A']);
    expect(canStartNextRound(s)).toBe(false);
  });
});

describe('helpers', () => {
  it('ignores words and finished flags from another round', () => {
    const old = memberState('Guest', 0, ['ant'], true);
    expect(wordsForRound(old, 1)).toEqual([]);
    expect(finishedRound(old, 1)).toBe(false);
    expect(wordsForRound(old, 0)).toEqual(['ant']);
    expect(finishedRound(null, 0)).toBe(false);
  });

  it('validWords keeps order and drops repeats', () => {
    expect(validWords(dict, 'A', ['axe', 'bee', 'axe', 'apple'])).toEqual(['axe', 'apple']);
  });

  it('resultsFor shows each player their own side as "player"', () => {
    const s = endRound(withClaims(playingState(1), ['apple'], ['axe', 'arm']), dict);
    expect(resultsFor(s.results, 'host')[0]).toMatchObject({ playerScore: 1, botScore: 2, playerWords: ['apple'] });
    expect(resultsFor(s.results, 'guest')[0]).toMatchObject({
      playerScore: 2,
      botScore: 1,
      playerWords: ['axe', 'arm'],
    });
  });
});

describe('word claims (each word once per round)', () => {
  it('gives the host a word unless the guest already owns it', () => {
    let s = acceptGuestClaims(playingState(), dict, ['axe']);
    expect(claimHostWord(s, 'axe')).toEqual({ ok: false, reason: 'taken' });
    const claim = claimHostWord(s, 'ant');
    expect(claim.ok).toBe(true);
    s = (claim as { state: LeaderState }).state;
    expect(s.claims).toEqual({ host: ['ant'], guest: ['axe'], rejected: [] });
  });

  it("turns down guest words the host owns, invalid words and repeats, in the guest's order", () => {
    const s = withClaims(playingState(), ['ant'], ['axe', 'ant', 'zzz', 'bee', 'axe', 'arm']);
    expect(s.claims).toEqual({ host: ['ant'], guest: ['axe', 'arm'], rejected: ['ant', 'zzz', 'bee'] });
  });

  it('decides each guest word once, and returns the same state when nothing is new', () => {
    const s1 = acceptGuestClaims(playingState(), dict, ['axe']);
    // Later the host takes "ant"; the guest's list still has "axe" (already decided) plus a late "ant".
    const s2 = (claimHostWord(s1, 'ant') as { state: LeaderState }).state;
    const s3 = acceptGuestClaims(s2, dict, ['axe', 'ant']);
    expect(s3.claims).toEqual({ host: ['ant'], guest: ['axe'], rejected: ['ant'] });
    expect(acceptGuestClaims(s3, dict, ['axe', 'ant'])).toBe(s3);
  });

  it('settles a race in the order the host handles the claims', () => {
    // Host handles its own "axe" first: the guest's "axe" arrives second and loses.
    const hostFirst = acceptGuestClaims((claimHostWord(playingState(), 'axe') as { state: LeaderState }).state, dict, [
      'axe',
    ]);
    expect(hostFirst.claims).toMatchObject({ host: ['axe'], guest: [], rejected: ['axe'] });
    // The guest's "axe" is handled first: the host's own "axe" is then refused.
    const guestFirst = acceptGuestClaims(playingState(), dict, ['axe']);
    expect(claimHostWord(guestFirst, 'axe')).toEqual({ ok: false, reason: 'taken' });
    expect(guestFirst.claims).toMatchObject({ host: [], guest: ['axe'], rejected: [] });
  });

  it('accepts no claims outside a playing round', () => {
    const s = createLeaderState({ rounds: 3, roundSeconds: 30 });
    expect(claimHostWord(s, 'axe')).toEqual({ ok: false, reason: 'round-over' });
    expect(acceptGuestClaims(s, dict, ['axe'])).toBe(s);
  });
});
