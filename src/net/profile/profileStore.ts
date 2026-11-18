/**
 * Saves finished matches and reads rankings, through a remote that is either
 * AGS (Cloud Save + Statistics + Leaderboard) or a local stand-in for mock mode.
 *
 * Each save goes through a small outbox kept in browser storage, so a match
 * finished while offline (or while AGS is unreachable) is saved later. A
 * ranked match updates the statistics at most once: the outbox entry is marked
 * as ranked as soon as the stat update succeeds, before the history is saved.
 */
import type { MatchRecord } from '../../game/history';
import {
  type Progress,
  type RankingUpdate,
  addMatch,
  clearMatches,
  emptyProgress,
  fitToBudget,
  rankingUpdate,
} from '../../game/progress';

export type BoardId = 'wins' | 'az';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  name: string;
  value: number;
}

export interface LeaderboardView {
  entries: LeaderboardEntry[];
  /** This player's rank and value, or null if they aren't on the board yet. */
  me: { rank: number; value: number } | null;
  myUserId: string;
}

/** Where progress and rankings live. */
export interface ProfileRemote {
  readonly kind: 'local' | 'ags';
  userId(): Promise<string>;
  loadProgress(): Promise<Progress | null>;
  saveProgress(progress: Progress): Promise<void>;
  /** Applies a ranked match: wins +1 if won, per-letter bests (MAX), then the A–Z best (sum of the 26 bests). */
  applyRanking(update: RankingUpdate): Promise<void>;
  /** Publishes the name shown next to this player on the leaderboards. */
  setPublicName(name: string): Promise<void>;
  leaderboard(board: BoardId, limit: number): Promise<LeaderboardView>;
  /** This player's best ranked score per letter. */
  letterBests(): Promise<Partial<Record<string, number>>>;
}

/** The bit of Storage the outbox needs (localStorage in the browser). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface OutboxEntry {
  record: MatchRecord;
  /** True once the statistics for this match were updated. */
  ranked: boolean;
}

export class ProfileStore {
  private progress: Progress = emptyProgress();
  private flushing: Promise<void> | null = null;
  private publishedName: string | null = null;

  /**
   * @param outboxKey where unsaved matches wait; pass a per-player key when
   * several players share one browser storage (mock mode: one guest per tab).
   */
  constructor(
    readonly remote: ProfileRemote,
    private readonly storage: KeyValueStorage | null,
    private readonly outboxKey = `letteroff:outbox:${remote.kind}`,
  ) {}

  get current(): Progress {
    return this.progress;
  }

  /** Matches finished but not saved yet. */
  get pendingCount(): number {
    return this.readOutbox().length;
  }

  /** Loads saved progress (and saves anything left in the outbox). */
  async load(): Promise<Progress> {
    this.progress = (await this.remote.loadProgress()) ?? emptyProgress();
    await this.flush();
    return this.progress;
  }

  /** Saves a finished match. Ranked (online) matches also update the leaderboards. Safe to call twice. */
  async saveMatch(record: MatchRecord): Promise<Progress> {
    const outbox = this.readOutbox();
    if (!outbox.some((e) => e.record.id === record.id) && !this.progress.counted.includes(record.id)) {
      this.writeOutbox([...outbox, { record, ranked: false }]);
    }
    // Show it straight away; the remote save follows.
    this.progress = addMatch(this.progress, record);
    await this.flush();
    return this.progress;
  }

  /** Clears the match list (lifetime totals stay). */
  async clearMatches(): Promise<Progress> {
    const fresh = (await this.remote.loadProgress()) ?? this.progress;
    this.progress = clearMatches(fresh);
    await this.remote.saveProgress(this.progress);
    return this.progress;
  }

  /** Saves everything in the outbox. Throws if the remote can't be reached; entries stay for the next try. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    for (const entry of this.readOutbox()) {
      const update = rankingUpdate(entry.record);
      if (update && !entry.ranked) {
        if (this.publishedName !== entry.record.playerName) {
          await this.remote.setPublicName(entry.record.playerName);
          this.publishedName = entry.record.playerName;
        }
        await this.remote.applyRanking(update);
        this.markRanked(entry.record.id);
      }
      // Read-modify-write, so a match saved from another tab isn't lost.
      const saved = (await this.remote.loadProgress()) ?? emptyProgress();
      const next = fitToBudget(addMatch(saved, entry.record));
      if (next !== saved) await this.remote.saveProgress(next);
      this.progress = next;
      this.writeOutbox(this.readOutbox().filter((e) => e.record.id !== entry.record.id));
    }
  }

  private markRanked(id: string): void {
    this.writeOutbox(this.readOutbox().map((e) => (e.record.id === id ? { ...e, ranked: true } : e)));
  }

  private readOutbox(): OutboxEntry[] {
    if (!this.storage) return this.memoryOutbox;
    try {
      const raw = this.storage.getItem(this.outboxKey);
      const data: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(data)
        ? data.filter((e): e is OutboxEntry => typeof e === 'object' && e !== null && 'record' in e)
        : [];
    } catch {
      return this.memoryOutbox;
    }
  }

  // Used when browser storage is blocked: the outbox lasts for this page only.
  private memoryOutbox: OutboxEntry[] = [];

  private writeOutbox(entries: OutboxEntry[]): void {
    this.memoryOutbox = entries;
    try {
      if (entries.length) this.storage?.setItem(this.outboxKey, JSON.stringify(entries));
      else this.storage?.removeItem(this.outboxKey);
    } catch {
      // Storage blocked or full: keep the in-memory copy.
    }
  }
}
