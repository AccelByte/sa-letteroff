import { describe, expect, it } from 'vitest';
import { Dictionary } from './dictionary';
import { ALPHABET } from './letters';
import {
  COUNTDOWN_MS,
  type MatchSettings,
  botWordsSoFar,
  countdownLeftMs,
  createMatch,
  currentLetter,
  finishAnswering,
  nextRound,
  submitWord,
  tick,
  timeLeftMs,
} from './match';
import { matchTotals } from './scoring';

// Ten tier-1 words for every letter, e.g. "a0word" .. "a9word", so any drawn letter works.
const dict = new Dictionary([
  ALPHABET.flatMap((l) => Array.from({ length: 10 }, (_, i) => `${l.toLowerCase()}${i}word`)),
]);

// Most tests skip the countdown so the round clock starts at T0; the countdown has its own tests.
const settings: MatchSettings = { rounds: 3, roundSeconds: 30, difficulty: 'easy', seed: 1234, countdownMs: 0 };
const T0 = 1_000_000;

describe('match flow', () => {
  it('starts in round 1 with distinct letters and a full timer', () => {
    const m = createMatch(settings, dict, T0);
    expect(m.phase).toBe('playing');
    expect(m.roundIndex).toBe(0);
    expect(new Set(m.letters).size).toBe(3);
    expect(timeLeftMs(m, T0)).toBe(30_000);
    expect(timeLeftMs(m, T0 + 10_000)).toBe(20_000);
  });

  it('is reproducible for a seed', () => {
    expect(createMatch(settings, dict, T0)).toEqual(createMatch(settings, dict, T0));
  });

  it('accepts valid words and rejects invalid ones without changing state', () => {
    let m = createMatch(settings, dict, T0);
    const l = currentLetter(m).toLowerCase();

    const ok = submitWord(m, dict, `${l}1word`, T0 + 100);
    expect(ok.result).toEqual({ ok: true, word: `${l}1word` });
    m = ok.state;

    for (const [input, reason] of [
      [`${l}1word`, 'already-used'],
      [`${l}nope`, 'not-a-word'],
      ['', 'empty'],
    ] as const) {
      const r = submitWord(m, dict, input, T0 + 200);
      expect(r.result).toMatchObject({ ok: false, reason });
      expect(r.state.playerWords).toEqual([`${l}1word`]);
    }
  });

  it('rejects words that start with another letter', () => {
    const m = createMatch(settings, dict, T0);
    const other = ALPHABET.find((x) => x !== currentLetter(m))!.toLowerCase();
    expect(submitWord(m, dict, `${other}1word`, T0).result).toMatchObject({ reason: 'wrong-letter' });
  });

  it('reveals bot words over time', () => {
    const m = createMatch(settings, dict, T0);
    const first = m.botPlan[0]!;
    expect(botWordsSoFar(tick(m, T0 + first.atMs - 1))).toEqual([]);
    expect(botWordsSoFar(tick(m, T0 + first.atMs))).toEqual([first.word]);
  });

  it('ends the round when time is up and rejects late words', () => {
    const m = createMatch(settings, dict, T0);
    const l = currentLetter(m).toLowerCase();
    const late = submitWord(m, dict, `${l}2word`, T0 + 30_000);
    expect(late.result).toMatchObject({ ok: false, reason: 'round-over' });
    expect(late.state.phase).toBe('round-over');
    expect(late.state.results).toHaveLength(1);
    expect(timeLeftMs(late.state, T0 + 30_000)).toBe(0);
  });

  it('lets the player take a word before the bot plays it; the bot then skips it', () => {
    let m = createMatch(settings, dict, T0);
    const first = m.botPlan[0]!;
    // The player gets there first: the bot's planned word is now taken.
    m = submitWord(m, dict, first.word, T0 + first.atMs - 1).state;
    m = tick(m, T0 + first.atMs);
    expect(botWordsSoFar(m)).not.toContain(first.word);
    m = tick(m, T0 + 30_000);
    const [result] = m.results;
    expect(result!.playerWords).toEqual([first.word]);
    expect(result!.botWords).not.toContain(first.word);
    expect(result!.shared).toEqual([]);
    expect(result!.botScore).toBe(m.botPlan.length - 1);
  });

  it('rejects a word the bot already played', () => {
    let m = createMatch(settings, dict, T0);
    const first = m.botPlan[0]!;
    const r = submitWord(m, dict, first.word, T0 + first.atMs);
    expect(r.result).toEqual({ ok: false, word: first.word, reason: 'taken' });
    expect(r.state.playerWords).toEqual([]);
    m = tick(r.state, T0 + 30_000);
    expect(m.results[0]!.botWords).toContain(first.word);
  });

  it('settles a near-simultaneous play by time: the earlier play wins, to the millisecond', () => {
    const m = createMatch(settings, dict, T0);
    const first = m.botPlan[0]!;
    expect(submitWord(m, dict, first.word, T0 + first.atMs - 1).result.ok).toBe(true);
    expect(submitWord(m, dict, first.word, T0 + first.atMs).result).toMatchObject({ reason: 'taken' });
  });

  it("does not let the bot take the player's words when the player finishes early", () => {
    let m = createMatch(settings, dict, T0);
    const late = m.botPlan.at(-1)!;
    m = submitWord(m, dict, late.word, T0 + 100).state;
    m = finishAnswering(m, T0 + 200);
    expect(m.results[0]!.botWords).not.toContain(late.word);
    expect(m.results[0]!.playerWords).toEqual([late.word]);
  });

  it('plays every round, then finishes with a table of results', () => {
    let m = createMatch(settings, dict, T0);
    let now = T0;
    for (let round = 0; round < 3; round++) {
      expect(m.roundIndex).toBe(round);
      expect(m.phase).toBe('playing');
      m = submitWord(m, dict, `${currentLetter(m).toLowerCase()}0word`, now + 50).state;
      now += 30_000;
      m = tick(m, now);
      if (round < 2) {
        expect(m.phase).toBe('round-over');
        expect(tick(m, now + 5000)).toBe(m); // time does not matter between rounds
        m = nextRound(m, dict, now);
      }
    }
    expect(m.phase).toBe('finished');
    expect(m.results.map((r) => r.letter)).toEqual(m.letters);
    expect(nextRound(m, dict, now)).toBe(m);
    const totals = matchTotals(m.results);
    expect(totals.player + totals.bot).toBeGreaterThan(0);
  });

  it('finishes straight away after a one-round match', () => {
    const m = tick(createMatch({ ...settings, rounds: 1 }, dict, T0), T0 + 30_000);
    expect(m.phase).toBe('finished');
  });

  it('ignores nextRound while a round is still being played', () => {
    const m = createMatch(settings, dict, T0);
    expect(nextRound(m, dict, T0 + 5)).toBe(m);
  });
});

describe('countdown', () => {
  const withCountdown: MatchSettings = { ...settings, countdownMs: undefined };

  it('starts each round with a countdown during which the clock does not run', () => {
    const m = createMatch(withCountdown, dict, T0);
    expect(m.phase).toBe('countdown');
    expect(countdownLeftMs(m, T0)).toBe(COUNTDOWN_MS);
    expect(countdownLeftMs(m, T0 + 1000)).toBe(COUNTDOWN_MS - 1000);
    expect(timeLeftMs(m, T0 + 2000)).toBe(30_000);
  });

  it('rejects words until the countdown ends', () => {
    const m = createMatch(withCountdown, dict, T0);
    const word = `${currentLetter(m).toLowerCase()}0word`;
    expect(submitWord(m, dict, word, T0 + COUNTDOWN_MS - 1).result).toMatchObject({ reason: 'not-started' });
    const started = submitWord(m, dict, word, T0 + COUNTDOWN_MS);
    expect(started.result.ok).toBe(true);
    expect(started.state.phase).toBe('playing');
    expect(timeLeftMs(started.state, T0 + COUNTDOWN_MS)).toBe(30_000);
  });

  it('times bot moves from the end of the countdown', () => {
    const m = createMatch(withCountdown, dict, T0);
    const first = m.botPlan[0]!;
    expect(botWordsSoFar(tick(m, T0 + first.atMs))).toEqual([]);
    expect(botWordsSoFar(tick(m, T0 + COUNTDOWN_MS + first.atMs))).toEqual([first.word]);
  });

  it('counts down again before the next round', () => {
    const m = tick(createMatch(withCountdown, dict, T0), T0 + COUNTDOWN_MS + 30_000);
    expect(m.phase).toBe('round-over');
    const next = nextRound(m, dict, T0 + 40_000);
    expect(next.phase).toBe('countdown');
    expect(next.roundStartedAt).toBe(T0 + 40_000 + COUNTDOWN_MS);
  });
});

describe('finishAnswering', () => {
  it('ends the round early and scores the bot as if time had run out', () => {
    let m = createMatch(settings, dict, T0);
    m = submitWord(m, dict, `${currentLetter(m).toLowerCase()}0word`, T0 + 100).state;
    const done = finishAnswering(m, T0 + 1000);
    expect(done.phase).toBe('round-over');
    expect(done.results[0]!.playerWords).toHaveLength(1);
    // The bot plays its whole plan, minus any word the player already took.
    const playerWord = done.results[0]!.playerWords[0];
    expect(done.results[0]!.botWords).toEqual(m.botPlan.map((move) => move.word).filter((w) => w !== playerWord));
    expect(submitWord(done, dict, 'anything', T0 + 1100).result).toMatchObject({ reason: 'round-over' });
  });

  it('finishes the match when used in the last round', () => {
    const m = finishAnswering(createMatch({ ...settings, rounds: 1 }, dict, T0), T0 + 10);
    expect(m.phase).toBe('finished');
  });

  it('does nothing during the countdown or after the round', () => {
    const counting = createMatch({ ...settings, countdownMs: undefined }, dict, T0);
    expect(finishAnswering(counting, T0 + 10)).toBe(counting);
    const over = tick(createMatch(settings, dict, T0), T0 + 30_000);
    expect(finishAnswering(over, T0 + 31_000)).toBe(over);
  });
});
