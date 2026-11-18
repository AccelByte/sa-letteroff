import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, type MatchRecord } from './history';
import {
  addMatch,
  clearMatches,
  emptyProgress,
  fitToBudget,
  mergeBests,
  overallTotals,
  parseProgress,
  progressFromMatches,
  progressSize,
  rankingUpdate,
  sumBests,
} from './progress';

const T0 = Date.UTC(2026, 10, 16, 3, 0, 0);

function online(id: string, rounds: [string, number, number][], roundSeconds: 30 | 60 = 60): MatchRecord {
  const player = rounds.reduce((s, r) => s + r[1], 0);
  const opp = rounds.reduce((s, r) => s + r[2], 0);
  return {
    id,
    playedAt: new Date(T0).toISOString(),
    playerName: 'Hana',
    rounds: 1,
    roundSeconds,
    mode: 'online',
    opponentName: 'Gus',
    seed: 0,
    results: rounds.map(([letter, p, o]) => ({
      letter,
      playerWords: Array.from({ length: p }, (_, i) => `${letter.toLowerCase()}word${i}`),
      botWords: [],
      shared: [],
      playerScore: p,
      botScore: o,
    })),
    playerTotal: player,
    botTotal: opp,
    winner: player > opp ? 'player' : opp > player ? 'bot' : 'draw',
  };
}

function bot(id: string, score: number): MatchRecord {
  return {
    ...online(id, [['A', score, 1]]),
    mode: 'bot',
    opponentName: undefined,
    difficulty: 'easy',
    roundSeconds: 60,
  };
}

describe('progress', () => {
  it('adds matches newest first and keeps lifetime totals per mode', () => {
    let p = emptyProgress();
    p = addMatch(p, online('m1', [['A', 5, 3]]));
    p = addMatch(p, bot('b1', 0));
    expect(p.matches.map((m) => m.id)).toEqual(['b1', 'm1']);
    expect(p.totals.online).toEqual({ played: 1, wins: 1, losses: 0, draws: 0, pointsFor: 5, pointsAgainst: 3 });
    expect(p.totals.bot).toMatchObject({ played: 1, wins: 0, losses: 1 });
    expect(overallTotals(p.totals)).toMatchObject({ played: 2, wins: 1, losses: 1 });
  });

  it('never counts the same match twice', () => {
    const m = online('m1', [['A', 5, 3]]);
    const p = addMatch(addMatch(emptyProgress(), m), m);
    expect(p.totals.online.played).toBe(1);
    expect(p.matches).toHaveLength(1);
  });

  it(`keeps the last ${HISTORY_LIMIT} matches but counts every match in the totals`, () => {
    let p = emptyProgress();
    for (let i = 0; i < HISTORY_LIMIT + 7; i++) p = addMatch(p, bot(`b${i}`, 2));
    expect(p.matches).toHaveLength(HISTORY_LIMIT);
    expect(p.matches[0]!.id).toBe(`b${HISTORY_LIMIT + 6}`);
    expect(p.totals.bot.played).toBe(HISTORY_LIMIT + 7);
  });

  it('clearing the list keeps the totals', () => {
    const p = clearMatches(addMatch(emptyProgress(), bot('b1', 2)));
    expect(p.matches).toEqual([]);
    expect(p.totals.bot.played).toBe(1);
  });
});

describe('rankings', () => {
  it('only online matches count; bot matches only go to history', () => {
    expect(rankingUpdate(bot('b1', 9))).toBeNull();
    expect(addMatch(emptyProgress(), bot('b1', 9)).totals.letterBests).toEqual({});
  });

  it('takes per-letter scores from 60-second rounds only', () => {
    expect(
      rankingUpdate(
        online('m1', [
          ['A', 4, 1],
          ['B', 2, 3],
        ]),
      ),
    ).toEqual({ win: true, letterScores: { A: 4, B: 2 } });
    expect(rankingUpdate(online('m2', [['A', 4, 1]], 30))).toEqual({ win: true, letterScores: {} });
    expect(rankingUpdate(online('m3', [['C', 1, 5]]))!.win).toBe(false);
  });

  it('keeps the best score per letter and sums them for the A-Z best', () => {
    let p = addMatch(
      emptyProgress(),
      online('m1', [
        ['A', 4, 1],
        ['B', 2, 3],
      ]),
    );
    p = addMatch(
      p,
      online('m2', [
        ['A', 3, 1],
        ['C', 6, 0],
      ]),
    );
    expect(p.totals.letterBests).toEqual({ A: 4, B: 2, C: 6 });
    expect(sumBests(p.totals.letterBests)).toBe(12);
    expect(mergeBests({ A: 4 }, { A: 7, Z: 1 })).toEqual({ A: 7, Z: 1 });
  });
});

describe('size budget', () => {
  it("drops the oldest matches' word lists first and keeps their scores", () => {
    let p = emptyProgress();
    for (let i = 0; i < 20; i++) p = addMatch(p, online(`m${i}`, [['A', 40, 1]]));
    const budget = progressSize(p) - 2000;
    const fitted = fitToBudget(p, budget);
    expect(progressSize(fitted)).toBeLessThanOrEqual(budget);
    expect(fitted.matches.at(-1)).toMatchObject({ trimmed: true, playerTotal: 40 });
    expect(fitted.matches.at(-1)!.results[0]!.playerWords).toEqual([]);
    expect(fitted.matches[0]!.trimmed).toBeUndefined();
    expect(fitted.totals).toEqual(p.totals);
    expect(fitToBudget(p, progressSize(p))).toBe(p);
  });
});

describe('parseProgress', () => {
  it('round-trips through JSON', () => {
    const p = addMatch(addMatch(emptyProgress(), online('m1', [['A', 4, 1]])), bot('b1', 1));
    expect(parseProgress(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it('rebuilds missing totals from the matches and drops malformed matches', () => {
    const parsed = parseProgress({ v: 1, matches: [online('m1', [['A', 4, 1]]), { id: 'junk' }] })!;
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.totals.online.played).toBe(1);
  });

  it('rejects anything else', () => {
    expect(parseProgress(null)).toBeNull();
    expect(parseProgress({ v: 2, matches: [] })).toBeNull();
  });

  it('imports an old match list', () => {
    const p = progressFromMatches([bot('b2', 1), bot('b1', 3)]);
    expect(p.matches.map((m) => m.id)).toEqual(['b2', 'b1']);
    expect(p.totals.bot.played).toBe(2);
  });
});
