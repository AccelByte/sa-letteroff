import { describe, expect, it } from 'vitest';
import { Dictionary } from './dictionary';
import {
  HISTORY_LIMIT,
  type MatchRecord,
  addRecord,
  createOnlineRecord,
  createRecord,
  historyStats,
  parseHistory,
  serializeHistory,
} from './history';
import { ALPHABET } from './letters';
import { createMatch, currentLetter, finishAnswering, submitWord } from './match';

const dict = new Dictionary([
  ALPHABET.flatMap((l) => Array.from({ length: 10 }, (_, i) => `${l.toLowerCase()}${i}word`)),
]);
const T0 = Date.UTC(2026, 10, 12, 3, 0, 0);

function finishedMatch(seed = 99) {
  let m = createMatch({ rounds: 1, roundSeconds: 30, difficulty: 'easy', seed, countdownMs: 0 }, dict, T0);
  m = submitWord(m, dict, `${currentLetter(m).toLowerCase()}0word`, T0 + 10).state;
  return finishAnswering(m, T0 + 20);
}

function record(id: string, winner: MatchRecord['winner'] = 'player'): MatchRecord {
  return {
    id,
    playedAt: new Date(T0).toISOString(),
    playerName: 'Mira',
    rounds: 1,
    roundSeconds: 30,
    difficulty: 'easy',
    seed: 1,
    results: [{ letter: 'A', playerWords: ['ant'], botWords: [], shared: [], playerScore: 1, botScore: 0 }],
    playerTotal: 1,
    botTotal: 0,
    winner,
  };
}

describe('createRecord', () => {
  it('summarises a finished match', () => {
    const m = finishedMatch();
    const r = createRecord(m, '  Mira ', T0 + 30)!;
    expect(r).toMatchObject({
      id: `${T0}-99`,
      playedAt: new Date(T0 + 30).toISOString(),
      playerName: 'Mira',
      rounds: 1,
      roundSeconds: 30,
      difficulty: 'easy',
      seed: 99,
    });
    expect(r.results).toEqual(m.results);
    expect(r.playerTotal).toBe(m.results[0]!.playerScore);
    expect(r.botTotal).toBe(m.results[0]!.botScore);
  });

  it('uses the default name when the name is blank', () => {
    expect(createRecord(finishedMatch(), '', T0)!.playerName).toBe('Player');
  });

  it('returns null for a match that is still going', () => {
    const m = createMatch({ rounds: 1, roundSeconds: 30, difficulty: 'easy', seed: 1 }, dict, T0);
    expect(createRecord(m, 'Mira', T0)).toBeNull();
  });
});

describe('addRecord', () => {
  it('puts the newest match first', () => {
    expect(addRecord([record('a')], record('b')).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('ignores a match that is already saved', () => {
    expect(addRecord([record('a')], record('a'))).toHaveLength(1);
  });

  it(`keeps only the latest ${HISTORY_LIMIT} matches`, () => {
    let history: MatchRecord[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) history = addRecord(history, record(`m${i}`));
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0]!.id).toBe(`m${HISTORY_LIMIT + 4}`);
    expect(history.at(-1)!.id).toBe('m5');
  });
});

describe('historyStats', () => {
  it('counts wins, losses and draws', () => {
    const stats = historyStats([record('a'), record('b', 'bot'), record('c', 'draw'), record('d')]);
    expect(stats).toEqual({ played: 4, wins: 2, losses: 1, draws: 1 });
  });
});

describe('parseHistory', () => {
  it('round-trips serialised history', () => {
    const history = [record('a'), record('b', 'bot')];
    expect(parseHistory(serializeHistory(history))).toEqual(history);
  });

  it.each([
    ['nothing stored', null],
    ['invalid JSON', '{nope'],
    ['an unknown version', JSON.stringify({ version: 99, matches: [] })],
    ['the wrong shape', JSON.stringify([1, 2, 3])],
  ])('returns an empty list for %s', (_, raw) => {
    expect(parseHistory(raw)).toEqual([]);
  });

  it('drops malformed records and keeps the rest', () => {
    const raw = JSON.stringify({
      version: 1,
      matches: [record('good'), { ...record('bad'), difficulty: 'impossible' }, { id: 'x' }, null],
    });
    expect(parseHistory(raw).map((r) => r.id)).toEqual(['good']);
  });

  it(`never returns more than ${HISTORY_LIMIT} records`, () => {
    const many = Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) => record(`m${i}`));
    expect(parseHistory(serializeHistory(many))).toHaveLength(HISTORY_LIMIT);
  });
});

describe('online records', () => {
  const results = [
    { letter: 'A', playerWords: ['ant'], botWords: ['axe', 'arm'], shared: [], playerScore: 1, botScore: 2 },
  ];

  it('creates a record for an online match', () => {
    const r = createOnlineRecord(
      { id: 's1', playerName: ' Mira ', opponentName: 'Gus', rounds: 1, roundSeconds: 30, results },
      T0,
    );
    expect(r).toMatchObject({
      id: 'online-s1',
      mode: 'online',
      opponentName: 'Gus',
      playerName: 'Mira',
      playerTotal: 1,
      botTotal: 2,
      winner: 'bot',
    });
    expect(r.difficulty).toBeUndefined();
    expect(parseHistory(serializeHistory([r]))).toEqual([r]);
  });

  it('still reads bot records saved before online play existed', () => {
    const old = { ...record('old') } as Partial<MatchRecord>;
    delete old.mode;
    expect(parseHistory(serializeHistory([old as MatchRecord]))).toHaveLength(1);
  });

  it('rejects online records without an opponent name', () => {
    const bad = {
      ...createOnlineRecord({ id: 'x', playerName: 'a', opponentName: 'b', rounds: 1, roundSeconds: 30, results }, T0),
    };
    delete (bad as Partial<MatchRecord>).opponentName;
    expect(parseHistory(serializeHistory([bad]))).toEqual([]);
  });
});
