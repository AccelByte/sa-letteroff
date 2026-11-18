/**
 * Persistence and rankings on AGS, called with the guest player's own token.
 *
 * - History and lifetime totals: the player's private Cloud Save record
 *   `letteroff-history` (only the owner can read it).
 * - Display name for the boards: a public player record `letteroff-profile`,
 *   read for other players with the bulk public-record endpoint.
 * - Rankings: Statistics set by the client (`setBy: CLIENT`), shown by two
 *   Leaderboard V3 all-time boards. See docs/ags-setup.md for the list.
 */
import { ALPHABET } from '../../game/letters';
import { type Progress, type RankingUpdate, parseProgress, progressFromMatches } from '../../game/progress';
import { parseHistory } from '../../game/history';
import { BackendError } from '../backend';
import type { BoardId, KeyValueStorage, LeaderboardView, ProfileRemote } from '../profile/profileStore';
import type { AgsAuth } from './auth';
import type { AgsConfig } from './config';
import { type Fetch, type RequestOptions, agsRequest } from './http';

export const HISTORY_RECORD_KEY = 'letteroff-history';
export const PROFILE_RECORD_KEY = 'letteroff-profile';

export const STAT_CODES = {
  wins: 'letteroff-wins',
  azBest: 'letteroff-az-best',
  letter: (letter: string) => `letteroff-best-${letter.toLowerCase()}`,
} as const;

export const LEADERBOARD_CODES: Record<BoardId, string> = { wins: 'letteroff-total-wins', az: 'letteroff-az-best' };

/** Stat codes per read; AGS limits bulk reads to 20 codes. */
const STAT_READ_CHUNK = 13;

interface StatUpdate {
  statCode: string;
  updateStrategy: 'INCREMENT' | 'MAX' | 'OVERRIDE';
  value: number;
}

export class AgsProfileRemote implements ProfileRemote {
  readonly kind = 'ags' as const;

  constructor(
    private readonly config: AgsConfig,
    private readonly auth: AgsAuth,
    private readonly fetchImpl: Fetch = (...args) => fetch(...args),
    /** Where the pre-AGS localStorage history lives, imported once into an empty Cloud Save record. */
    private readonly legacyStorage: KeyValueStorage | null = null,
  ) {}

  async userId(): Promise<string> {
    return (this.auth.current ?? (await this.auth.login())).userId;
  }

  async loadProgress(): Promise<Progress | null> {
    try {
      const data = (await this.call('GET', await this.recordUrl(HISTORY_RECORD_KEY))) as { value?: unknown };
      return parseProgress(data?.value);
    } catch (error) {
      if (!(error instanceof BackendError && error.status === 404)) throw error;
      const old = parseHistory(this.legacyStorage?.getItem('letteroff:history') ?? null);
      return old.length ? progressFromMatches(old) : null;
    }
  }

  async saveProgress(progress: Progress): Promise<void> {
    // A plain player record is private: only this player can read it.
    await this.call('PUT', await this.recordUrl(HISTORY_RECORD_KEY), { body: progress });
  }

  async applyRanking(update: RankingUpdate): Promise<void> {
    const changes: StatUpdate[] = Object.entries(update.letterScores).map(([letter, value]) => ({
      statCode: STAT_CODES.letter(letter),
      updateStrategy: 'MAX',
      value: value ?? 0,
    }));
    if (update.win) changes.push({ statCode: STAT_CODES.wins, updateStrategy: 'INCREMENT', value: 1 });
    if (changes.length === 0) return;
    await this.updateStats(changes);
    if (Object.keys(update.letterScores).length === 0) return;
    // The A–Z best is the sum of the letter bests as AGS now has them (MAX keeps the higher value).
    const bests = await this.letterBests();
    const sum = ALPHABET.reduce((total, letter) => total + (bests[letter] ?? 0), 0);
    await this.updateStats([{ statCode: STAT_CODES.azBest, updateStrategy: 'OVERRIDE', value: sum }]);
  }

  async setPublicName(name: string): Promise<void> {
    await this.call('PUT', await this.recordUrl(PROFILE_RECORD_KEY), { body: { name, __META: { is_public: true } } });
  }

  async leaderboard(board: BoardId, limit: number): Promise<LeaderboardView> {
    const userId = await this.userId();
    const base = `${this.config.apiBase}/leaderboard/v3/public/namespaces/${this.config.namespace}/leaderboards/${LEADERBOARD_CODES[board]}`;
    // AGS answers 404 (error 71235/71233) for a board with no entries, or a player not on it yet.
    const orEmpty = <T>(error: unknown): T | null => {
      if (error instanceof BackendError && error.status === 404) return null;
      throw error;
    };
    const [page, mine] = await Promise.all([
      (
        this.call('GET', `${base}/alltime?offset=0&limit=${limit}`) as Promise<{
          data?: { userId: string; point: number; hidden?: boolean }[];
        }>
      ).catch(orEmpty<{ data?: { userId: string; point: number; hidden?: boolean }[] }>),
      (
        this.call('GET', `${base}/users/${encodeURIComponent(userId)}`) as Promise<{
          allTime?: { point: number; rank: number };
        }>
      ).catch(orEmpty<{ allTime?: { point: number; rank: number } }>),
    ]);
    // The all-time list is already sorted and has no rank field: rank is the position (offset 0).
    const rows = (page?.data ?? []).map((r, i) => ({ ...r, rank: i + 1 })).filter((r) => !r.hidden);
    const names = await this.publicNames(rows.map((r) => r.userId));
    return {
      entries: rows.map((r) => ({ rank: r.rank, userId: r.userId, name: names[r.userId] ?? 'Player', value: r.point })),
      me: mine?.allTime && mine.allTime.rank > 0 ? { rank: mine.allTime.rank, value: mine.allTime.point } : null,
      myUserId: userId,
    };
  }

  async letterBests(): Promise<Partial<Record<string, number>>> {
    const codes = ALPHABET.map(STAT_CODES.letter);
    const bests: Partial<Record<string, number>> = {};
    for (let i = 0; i < codes.length; i += STAT_READ_CHUNK) {
      const query = codes
        .slice(i, i + STAT_READ_CHUNK)
        .map((c) => `statCodes=${encodeURIComponent(c)}`)
        .join('&');
      const items = (await this.call(
        'GET',
        `${this.config.apiBase}/social/v1/public/namespaces/${this.config.namespace}/users/me/statitems/value/bulk?${query}`,
      )) as { statCode: string; value: number }[];
      for (const item of items ?? []) {
        const letter = item.statCode.slice(-1).toUpperCase();
        if (item.value > 0) bests[letter] = item.value;
      }
    }
    return bests;
  }

  private async updateStats(changes: StatUpdate[]): Promise<void> {
    const userId = await this.userId();
    const result = (await this.call(
      'PUT',
      `${this.config.apiBase}/social/v2/public/namespaces/${this.config.namespace}/users/${encodeURIComponent(userId)}/statitems/value/bulk`,
      { body: changes },
    )) as { statCode: string; success: boolean; details?: unknown }[];
    const failed = (result ?? []).filter((r) => !r.success);
    if (failed.length) {
      throw new BackendError('other', `AGS rejected stat updates: ${failed.map((f) => f.statCode).join(', ')}`);
    }
  }

  private async publicNames(userIds: string[]): Promise<Record<string, string>> {
    if (userIds.length === 0) return {};
    const names: Record<string, string> = {};
    for (let i = 0; i < userIds.length; i += 20) {
      const data = (await this.call(
        'POST',
        `${this.config.apiBase}/cloudsave/v1/namespaces/${this.config.namespace}/users/bulk/records/${PROFILE_RECORD_KEY}/public`,
        { body: { userIds: userIds.slice(i, i + 20) } },
      )) as { data?: { user_id: string; value?: { name?: unknown } }[] };
      for (const r of data?.data ?? []) {
        if (typeof r.value?.name === 'string' && r.value.name.trim()) names[r.user_id] = r.value.name.slice(0, 20);
      }
    }
    return names;
  }

  private async recordUrl(key: string): Promise<string> {
    const userId = await this.userId();
    return `${this.config.apiBase}/cloudsave/v1/namespaces/${this.config.namespace}/users/${encodeURIComponent(userId)}/records/${key}`;
  }

  /** Authenticated call; on 401 it refreshes the token once and retries. */
  private async call(method: string, url: string, options: RequestOptions = {}): Promise<unknown> {
    const withToken = (token: string) =>
      agsRequest(this.fetchImpl, method, url, { ...options, headers: { Authorization: `Bearer ${token}` } });
    try {
      return await withToken(await this.auth.accessToken());
    } catch (error) {
      if (error instanceof BackendError && error.status === 401)
        return withToken((await this.auth.refresh()).accessToken);
      throw error;
    }
  }
}
