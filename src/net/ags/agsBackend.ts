/**
 * The AGS backend. Every call uses the guest player's own token; there is no
 * client secret anywhere. Endpoints and request bodies match what was verified
 * against a live AGS namespace (see docs/ags-setup.md).
 *
 * Note: the AccelByte Web SDK (@accelbyte/sdk-session 5.3.7) sends an empty
 * body for the two session-storage writes, so this backend calls AGS's REST
 * endpoints directly with fetch.
 */
import type { LeaderState, MemberState, SessionSnapshot } from '../../game/online/protocol';
import { PROTOCOL_VERSION } from '../../game/online/protocol';
import {
  type BackendEvent,
  BackendError,
  Emitter,
  type OnlineBackend,
  type Player,
  type StorageChange,
  type TicketStatus,
} from '../backend';
import { AgsAuth } from './auth';
import type { AgsConfig } from './config';
import { type Fetch, type RequestOptions, agsRequest } from './http';
import { LobbyConnection, type LobbyMessage, type WebSocketFactory } from './lobby';

export interface AgsBackendOptions {
  config: AgsConfig;
  deviceId: string;
  fetchImpl?: Fetch;
  createSocket?: WebSocketFactory;
  /** Set false in tests to skip the Lobby connection. */
  connectLobby?: boolean;
  /** Share a login with other AGS features (Cloud Save, leaderboards). Not disposed with the backend. */
  auth?: AgsAuth;
}

interface AgsSession {
  id: string;
  code?: string | null;
  leaderID?: string;
  members?: { id: string; status?: string; statusV2?: string }[];
  storage?: { leader?: unknown; member?: Record<string, unknown> } | null;
}

/**
 * Reads an OnSessionStorageChanged notification. Verified live: the payload is
 * base64 JSON `{ SessionID, ActorUserID, StorageChanges, IsLeader? }`, where
 * StorageChanges is the object that was written and IsLeader is only present
 * (true) for leader storage. Every member gets one per write, about 60-120 ms
 * after the write is acknowledged.
 */
export function storageChangeFrom(message: LobbyMessage): { sessionId: string; storage: StorageChange } | null {
  if (message.topic !== 'OnSessionStorageChanged' || !message.payload) return null;
  try {
    const p = JSON.parse(atob(message.payload)) as {
      SessionID?: unknown;
      ActorUserID?: unknown;
      StorageChanges?: unknown;
      IsLeader?: unknown;
    };
    if (typeof p.SessionID !== 'string' || typeof p.ActorUserID !== 'string' || p.StorageChanges === undefined) {
      return null;
    }
    return {
      sessionId: p.SessionID,
      storage: { kind: p.IsLeader === true ? 'leader' : 'member', userId: p.ActorUserID, data: p.StorageChanges },
    };
  } catch {
    return null;
  }
}

/** Converts an AGS game session response into the snapshot the game uses. */
export function toSnapshot(data: unknown): SessionSnapshot {
  const s = data as AgsSession;
  if (!s || typeof s.id !== 'string') throw new BackendError('other', 'Unexpected session response from AGS.');
  return {
    id: s.id,
    code: s.code ?? null,
    leaderId: s.leaderID ?? '',
    members: (s.members ?? []).map((m) => ({ userId: m.id, status: m.statusV2 || m.status || 'JOINED' })),
    leaderStorage: s.storage?.leader ?? null,
    memberStorage: s.storage?.member ?? {},
  };
}

export class AgsBackend implements OnlineBackend {
  readonly mode = 'ags' as const;
  private readonly config: AgsConfig;
  private readonly fetchImpl: Fetch;
  private readonly auth: AgsAuth;
  private readonly ownsAuth: boolean;
  private readonly events = new Emitter<BackendEvent>();
  private readonly lobby: LobbyConnection | null;

  constructor(options: AgsBackendOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.ownsAuth = !options.auth;
    this.auth =
      options.auth ?? new AgsAuth(this.fetchImpl, this.config.apiBase, this.config.clientId, options.deviceId);
    this.lobby =
      options.connectLobby === false
        ? null
        : new LobbyConnection(
            this.config.lobbyUrl,
            () => this.auth.accessToken(),
            (message) => {
              // A storage notification carries the new value: pass it on so it can be applied without a read.
              const storage = storageChangeFrom(message);
              if (storage) {
                this.events.emit({ type: 'session-changed', ...storage });
                return;
              }
              // Any other notification may mean the session or ticket changed: re-read it.
              if (message.type.toLowerCase().includes('notif')) {
                this.events.emit({ type: 'session-changed' });
                const text = `${message.type} ${message.topic ?? ''}`.toLowerCase();
                if (text.includes('match')) this.events.emit({ type: 'match-found' });
              }
            },
            (state) => this.events.emit({ type: 'connection', state }),
            options.createSocket,
            () => this.auth.refresh(),
          );
  }

  async login(): Promise<Player> {
    const token = this.auth.current ?? (await this.auth.login());
    void this.lobby?.connect();
    return { userId: token.userId };
  }

  /** AGS Basic `GET /basic/v1/public/misc/time` (millisecond precision). Call after login. */
  async serverTime(): Promise<number> {
    const data = (await this.call('GET', `${this.config.apiBase}/basic/v1/public/misc/time`)) as {
      currentTime?: string;
    };
    const time = Date.parse(data?.currentTime ?? '');
    if (!Number.isFinite(time)) throw new BackendError('other', 'Unexpected server time response from AGS.');
    return time;
  }

  async createRoom(): Promise<SessionSnapshot> {
    const data = await this.call('POST', this.session('/gamesession'), {
      body: {
        configurationName: this.config.sessionTemplate,
        attributes: { game: 'letteroff', protocol: PROTOCOL_VERSION },
      },
    });
    return toSnapshot(data);
  }

  async joinByCode(code: string): Promise<SessionSnapshot> {
    try {
      const data = await this.call('POST', this.session('/gamesessions/join/code'), {
        body: { code: code.trim().toUpperCase() },
      });
      return toSnapshot(data);
    } catch (error) {
      if (error instanceof BackendError && (error.status === 404 || error.status === 400)) {
        throw new BackendError('invalid-code', error.message, error.status);
      }
      if (error instanceof BackendError && error.status === 409) {
        throw new BackendError('room-full', error.message, error.status);
      }
      throw error;
    }
  }

  async getSession(sessionId: string): Promise<SessionSnapshot> {
    return toSnapshot(await this.call('GET', this.session(`/gamesessions/${encodeURIComponent(sessionId)}`)));
  }

  async leaveSession(sessionId: string, options: { keepalive?: boolean } = {}): Promise<void> {
    await this.call('DELETE', this.session(`/gamesessions/${encodeURIComponent(sessionId)}/leave`), {
      keepalive: options.keepalive,
    });
  }

  async writeLeaderStorage(sessionId: string, data: LeaderState): Promise<void> {
    await this.call('PATCH', this.session(`/sessions/${encodeURIComponent(sessionId)}/storage/leader`), { body: data });
  }

  async writeMemberStorage(sessionId: string, userId: string, data: MemberState): Promise<void> {
    await this.call(
      'PATCH',
      this.session(`/sessions/${encodeURIComponent(sessionId)}/storage/users/${encodeURIComponent(userId)}`),
      { body: data },
    );
  }

  async createTicket(): Promise<string> {
    const data = (await this.call('POST', this.match('/match-tickets'), {
      body: { matchPool: this.config.matchPool, attributes: { protocol: PROTOCOL_VERSION }, latencies: {} },
    })) as { matchTicketID?: string };
    if (typeof data?.matchTicketID !== 'string')
      throw new BackendError('other', 'Unexpected ticket response from AGS.');
    return data.matchTicketID;
  }

  async getTicket(ticketId: string): Promise<TicketStatus> {
    const data = (await this.call('GET', this.match(`/match-tickets/${encodeURIComponent(ticketId)}`))) as {
      matchFound?: boolean;
      sessionID?: string;
    };
    return { matchFound: !!data?.matchFound, sessionId: data?.sessionID || null };
  }

  async cancelTicket(ticketId: string, options: { keepalive?: boolean } = {}): Promise<void> {
    await this.call('DELETE', this.match(`/match-tickets/${encodeURIComponent(ticketId)}`), {
      keepalive: options.keepalive,
    });
  }

  subscribe(listener: (event: BackendEvent) => void): () => void {
    return this.events.on(listener);
  }

  dispose(): void {
    this.lobby?.disconnect();
    if (this.ownsAuth) this.auth.dispose();
    this.events.clear();
  }

  private session(path: string): string {
    return `${this.config.apiBase}/session/v1/public/namespaces/${this.config.namespace}${path}`;
  }

  private match(path: string): string {
    return `${this.config.apiBase}/match2/v1/namespaces/${this.config.namespace}${path}`;
  }

  /** Authenticated call; on 401 it refreshes the token once and retries. */
  private async call(method: string, url: string, options: RequestOptions = {}): Promise<unknown> {
    const withToken = async (token: string) =>
      agsRequest(this.fetchImpl, method, url, { ...options, headers: { Authorization: `Bearer ${token}` } });
    try {
      return await withToken(await this.auth.accessToken());
    } catch (error) {
      if (error instanceof BackendError && error.status === 401) {
        return withToken((await this.auth.refresh()).accessToken);
      }
      throw error;
    }
  }
}
