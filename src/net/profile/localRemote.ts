/**
 * Mock-mode stand-in for Cloud Save, Statistics and Leaderboard, kept in
 * browser storage. As in AGS, everything belongs to the current player, which
 * in mock mode is the tab's guest: tabs playing each other each keep their own
 * history and show up on the same boards. The history saved by earlier
 * versions (`letteroff:history`) is imported once, by the first tab to load.
 */
import { parseHistory } from '../../game/history';
import { ALPHABET } from '../../game/letters';
import {
  type Progress,
  type RankingUpdate,
  mergeBests,
  parseProgress,
  progressFromMatches,
  sumBests,
} from '../../game/progress';
import type { BoardId, KeyValueStorage, LeaderboardView, ProfileRemote } from './profileStore';

export const LOCAL_KEYS = {
  progress: (userId: string) => `letteroff:progress:${userId}`,
  oldHistory: 'letteroff:history',
  oldHistoryImported: 'letteroff:history-imported',
  stats: 'letteroff:mock-stats',
} as const;

interface MockStats {
  name: string;
  wins: number;
  bests: Partial<Record<string, number>>;
  az: number;
}

export class LocalProfileRemote implements ProfileRemote {
  readonly kind = 'local' as const;

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly currentUserId: () => string,
  ) {}

  async userId(): Promise<string> {
    return this.currentUserId();
  }

  async loadProgress(): Promise<Progress | null> {
    const raw = this.storage.getItem(LOCAL_KEYS.progress(this.currentUserId()));
    if (raw) {
      try {
        return parseProgress(JSON.parse(raw));
      } catch {
        return null;
      }
    }
    if (this.storage.getItem(LOCAL_KEYS.oldHistoryImported)) return null;
    const old = parseHistory(this.storage.getItem(LOCAL_KEYS.oldHistory));
    return old.length ? progressFromMatches(old) : null;
  }

  async saveProgress(progress: Progress): Promise<void> {
    this.storage.setItem(LOCAL_KEYS.progress(this.currentUserId()), JSON.stringify(progress));
    this.storage.setItem(LOCAL_KEYS.oldHistoryImported, '1');
  }

  async applyRanking(update: RankingUpdate): Promise<void> {
    const all = this.readStats();
    const id = this.currentUserId();
    const mine = all[id] ?? { name: 'Player', wins: 0, bests: {}, az: 0 };
    const bests = mergeBests(mine.bests, update.letterScores);
    all[id] = { ...mine, wins: mine.wins + (update.win ? 1 : 0), bests, az: sumBests(bests) };
    this.writeStats(all);
  }

  async setPublicName(name: string): Promise<void> {
    const all = this.readStats();
    const id = this.currentUserId();
    all[id] = { ...(all[id] ?? { wins: 0, bests: {}, az: 0 }), name };
    this.writeStats(all);
  }

  async leaderboard(board: BoardId, limit: number): Promise<LeaderboardView> {
    const value = (s: MockStats) => (board === 'wins' ? s.wins : s.az);
    const myUserId = this.currentUserId();
    const ranked = Object.entries(this.readStats())
      .filter(([, s]) => value(s) > 0)
      .sort(([, a], [, b]) => value(b) - value(a))
      .map(([userId, s], i) => ({ rank: i + 1, userId, name: s.name, value: value(s) }));
    const me = ranked.find((e) => e.userId === myUserId);
    return { entries: ranked.slice(0, limit), me: me ? { rank: me.rank, value: me.value } : null, myUserId };
  }

  async letterBests(): Promise<Partial<Record<string, number>>> {
    const bests = this.readStats()[this.currentUserId()]?.bests ?? {};
    return Object.fromEntries(ALPHABET.filter((l) => bests[l]).map((l) => [l, bests[l]]));
  }

  private readStats(): Record<string, MockStats> {
    try {
      const data: unknown = JSON.parse(this.storage.getItem(LOCAL_KEYS.stats) ?? '{}');
      return typeof data === 'object' && data !== null ? (data as Record<string, MockStats>) : {};
    } catch {
      return {};
    }
  }

  private writeStats(stats: Record<string, MockStats>): void {
    this.storage.setItem(LOCAL_KEYS.stats, JSON.stringify(stats));
  }
}
