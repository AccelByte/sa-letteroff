import { describe, expect, it } from 'vitest';
import type { MatchRecord } from '../../game/history';
import type { Progress, RankingUpdate } from '../../game/progress';
import { LocalProfileRemote } from './localRemote';
import { type KeyValueStorage, ProfileStore } from './profileStore';

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function match(id: string, mode: 'bot' | 'online', score: number, opp: number, letter = 'A'): MatchRecord {
  return {
    id,
    playedAt: new Date(Date.UTC(2026, 10, 16)).toISOString(),
    playerName: 'Hana',
    rounds: 1,
    roundSeconds: 60,
    ...(mode === 'online' ? { mode, opponentName: 'Gus' } : { mode, difficulty: 'easy' as const }),
    seed: 0,
    results: [{ letter, playerWords: [], botWords: [], shared: [], playerScore: score, botScore: opp }],
    playerTotal: score,
    botTotal: opp,
    winner: score > opp ? 'player' : score < opp ? 'bot' : 'draw',
  };
}

/** Local remote that can be made to fail, and counts ranking updates. */
class FlakyRemote extends LocalProfileRemote {
  failSaves = false;
  failRanking = false;
  rankings: RankingUpdate[] = [];
  override async saveProgress(p: Progress) {
    if (this.failSaves) throw new Error('offline');
    return super.saveProgress(p);
  }
  override async applyRanking(u: RankingUpdate) {
    if (this.failRanking) throw new Error('offline');
    this.rankings.push(u);
    return super.applyRanking(u);
  }
}

describe('ProfileStore (local remote)', () => {
  it('saves bot matches to history only and online matches to history and rankings', async () => {
    const storage = memoryStorage();
    const store = new ProfileStore(new LocalProfileRemote(storage, () => 'hana'), storage);
    await store.load();
    await store.saveMatch(match('b1', 'bot', 9, 1));
    await store.saveMatch(match('o1', 'online', 5, 3, 'C'));
    expect(store.current.matches.map((m) => m.id)).toEqual(['o1', 'b1']);
    const wins = await store.remote.leaderboard('wins', 10);
    expect(wins.entries).toEqual([{ rank: 1, userId: 'hana', name: 'Hana', value: 1 }]);
    expect(wins.me).toEqual({ rank: 1, value: 1 });
    expect(await store.remote.letterBests()).toEqual({ C: 5 });
    expect((await store.remote.leaderboard('az', 10)).entries[0]!.value).toBe(5);
    // Reloading from storage gives the same progress.
    const again = new ProfileStore(new LocalProfileRemote(storage, () => 'hana'), storage);
    expect((await again.load()).totals).toEqual(store.current.totals);
  });

  it('two players on one browser see each other on the boards, ranked by value', async () => {
    const storage = memoryStorage();
    const hana = new ProfileStore(new LocalProfileRemote(storage, () => 'hana'), storage, 'ob-h');
    const gus = new ProfileStore(new LocalProfileRemote(storage, () => 'gus'), storage, 'ob-g');
    await hana.saveMatch(match('o1-h', 'online', 5, 3));
    await gus.saveMatch({ ...match('o1-g', 'online', 7, 2), playerName: 'Gus' });
    const board = await hana.remote.leaderboard('az', 10);
    expect(board.entries.map((e) => [e.name, e.value])).toEqual([
      ['Gus', 7],
      ['Hana', 5],
    ]);
    expect(board.me).toEqual({ rank: 2, value: 5 });
  });

  it('keeps a match in the outbox while saving fails, then saves it once', async () => {
    const storage = memoryStorage();
    const remote = new FlakyRemote(storage, () => 'hana');
    const store = new ProfileStore(remote, storage);
    remote.failSaves = true;
    await expect(store.saveMatch(match('o1', 'online', 5, 3))).rejects.toThrow('offline');
    expect(store.pendingCount).toBe(1);
    expect(store.current.matches).toHaveLength(1); // shown straight away
    expect(remote.rankings).toHaveLength(1); // stats went through before the history save failed

    remote.failSaves = false;
    await store.load(); // e.g. next visit
    expect(store.pendingCount).toBe(0);
    expect(remote.rankings).toHaveLength(1); // not counted twice
    expect(store.current.totals.online.played).toBe(1);
    expect((await remote.leaderboard('wins', 10)).entries[0]!.value).toBe(1);
  });

  it('retries the ranking update if it failed', async () => {
    const storage = memoryStorage();
    const remote = new FlakyRemote(storage, () => 'hana');
    const store = new ProfileStore(remote, storage);
    remote.failRanking = true;
    await expect(store.saveMatch(match('o1', 'online', 5, 3))).rejects.toThrow();
    remote.failRanking = false;
    await store.flush();
    expect(remote.rankings).toHaveLength(1);
    expect(store.pendingCount).toBe(0);
  });

  it('saving the same match twice changes nothing', async () => {
    const storage = memoryStorage();
    const remote = new FlakyRemote(storage, () => 'hana');
    const store = new ProfileStore(remote, storage);
    await store.saveMatch(match('o1', 'online', 5, 3));
    await store.saveMatch(match('o1', 'online', 5, 3));
    expect(remote.rankings).toHaveLength(1);
    expect(store.current.totals.online.played).toBe(1);
  });

  it('clearing history keeps lifetime totals', async () => {
    const storage = memoryStorage();
    const store = new ProfileStore(new LocalProfileRemote(storage, () => 'hana'), storage);
    await store.saveMatch(match('b1', 'bot', 1, 2));
    await store.clearMatches();
    expect(store.current.matches).toEqual([]);
    expect(store.current.totals.bot.played).toBe(1);
  });

  it('imports the old localStorage history on first load', async () => {
    const storage = memoryStorage();
    storage.setItem('letteroff:history', JSON.stringify({ version: 1, matches: [match('old', 'bot', 3, 1)] }));
    const store = new ProfileStore(new LocalProfileRemote(storage, () => 'hana'), storage);
    expect((await store.load()).matches.map((m) => m.id)).toEqual(['old']);
  });
});
