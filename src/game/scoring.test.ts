import { describe, expect, it } from 'vitest';
import { matchTotals, scoreRound } from './scoring';

describe('scoreRound', () => {
  it('gives one point per unique word', () => {
    const r = scoreRound('A', ['apple', 'ant', 'axe'], ['arm']);
    expect(r).toMatchObject({ playerScore: 3, botScore: 1, shared: [] });
  });

  it('cancels words that both sides played', () => {
    const r = scoreRound('A', ['apple', 'ant', 'axe'], ['ant', 'arm', 'apple']);
    expect(r.shared).toEqual(['apple', 'ant']);
    expect(r.playerScore).toBe(1);
    expect(r.botScore).toBe(1);
  });

  it('ignores duplicates within one side', () => {
    expect(scoreRound('A', ['ant', 'ant'], []).playerScore).toBe(1);
  });

  it('scores an empty round as 0-0', () => {
    expect(scoreRound('Q', [], [])).toMatchObject({ playerScore: 0, botScore: 0 });
  });
});

describe('matchTotals', () => {
  const round = (p: number, b: number) => ({
    letter: 'A',
    playerWords: [],
    botWords: [],
    shared: [],
    playerScore: p,
    botScore: b,
  });

  it('sums rounds and picks the winner', () => {
    expect(matchTotals([round(3, 1), round(0, 4)])).toEqual({ player: 3, bot: 5, winner: 'bot' });
    expect(matchTotals([round(5, 1)])).toMatchObject({ winner: 'player' });
  });

  it('reports a draw on equal totals', () => {
    expect(matchTotals([round(2, 3), round(3, 2)])).toMatchObject({ winner: 'draw' });
    expect(matchTotals([])).toEqual({ player: 0, bot: 0, winner: 'draw' });
  });
});
