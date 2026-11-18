/**
 * An in-browser stand-in for AGS. Each tab is a different guest. Sessions,
 * join codes, storage and the matchmaking queue live in a shared store
 * (localStorage in the browser), and the rules follow what was verified
 * against AGS Session V2:
 *
 * - only the leader may write leader storage, and a player may only write
 *   their own member storage (both only while active in the session);
 * - each storage write replaces the whole object;
 * - a player who stops sending heartbeats becomes DISCONNECTED, then DROPPED
 *   (AGS does this from the Lobby connection and the template's inactive
 *   timeout; the mock uses shorter times);
 * - if the leader leaves or is dropped, the oldest remaining member leads.
 */
import type { LeaderState, MemberState, SessionMember, SessionSnapshot } from '../../game/online/protocol';
import {
  type BackendEvent,
  BackendError,
  Emitter,
  type OnlineBackend,
  type Player,
  type StorageChange,
  type TicketStatus,
} from '../backend';
import type { MockStore } from './store';

export interface MockOptions {
  store: MockStore;
  userId: string;
  now?: () => number;
  /** Simulated network delay per call, so timing bugs show up locally. */
  latencyMs?: number;
  heartbeatMs?: number;
  disconnectAfterMs?: number;
  dropAfterMs?: number;
  ticketExpiryMs?: number;
  /** Set false in tests that drive heartbeats by hand. */
  autoHeartbeat?: boolean;
}

interface StoredMember {
  userId: string;
  status: 'JOINED' | 'LEFT';
  joinedAt: number;
}

interface StoredSession {
  id: string;
  code: string;
  createdAt: number;
  members: StoredMember[];
  leaderStorage: unknown;
  memberStorage: Record<string, unknown>;
}

interface StoredTicket {
  id: string;
  userId: string;
  createdAt: number;
  sessionId: string | null;
}

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_PLAYERS = 2;
const key = {
  session: (id: string) => `letteroff:mock:session:${id}`,
  code: (code: string) => `letteroff:mock:code:${code}`,
  heartbeat: (userId: string) => `letteroff:mock:heartbeat:${userId}`,
  ticket: (id: string) => `letteroff:mock:ticket:${id}`,
  queue: 'letteroff:mock:queue',
};

const randomId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
const randomCode = () =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');

export class MockBackend implements OnlineBackend {
  readonly mode = 'mock' as const;
  private readonly store: MockStore;
  private readonly userId: string;
  private readonly now: () => number;
  private readonly latencyMs: number;
  private readonly disconnectAfterMs: number;
  private readonly dropAfterMs: number;
  private readonly ticketExpiryMs: number;
  private readonly events = new Emitter<BackendEvent>();
  private readonly stopBroadcast: () => void;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MockOptions) {
    this.store = options.store;
    this.userId = options.userId;
    this.now = options.now ?? Date.now;
    this.latencyMs = options.latencyMs ?? 0;
    this.disconnectAfterMs = options.disconnectAfterMs ?? 6000;
    this.dropAfterMs = options.dropAfterMs ?? 20_000;
    this.ticketExpiryMs = options.ticketExpiryMs ?? 60_000;
    this.stopBroadcast = this.store.onBroadcast((message) => {
      if (isEvent(message)) this.events.emit(message);
    });
    if (options.autoHeartbeat ?? true) {
      this.heartbeat();
      this.heartbeatTimer = setInterval(() => this.heartbeat(), options.heartbeatMs ?? 2000);
    }
  }

  /** Marks this player as connected. Called on a timer unless autoHeartbeat is off. */
  heartbeat(): void {
    this.store.set(key.heartbeat(this.userId), String(this.now()));
  }

  /** Every tab of one browser shares the same clock. */
  async serverTime(): Promise<number> {
    return this.now();
  }

  async login(): Promise<Player> {
    await this.delay();
    this.heartbeat();
    this.events.emit({ type: 'connection', state: 'connected' });
    return { userId: this.userId };
  }

  async createRoom(): Promise<SessionSnapshot> {
    await this.delay();
    const session = await this.store.withLock(() => {
      let code = randomCode();
      while (this.store.get(key.code(code))) code = randomCode();
      const s: StoredSession = {
        id: randomId(),
        code,
        createdAt: this.now(),
        members: [{ userId: this.userId, status: 'JOINED', joinedAt: this.now() }],
        leaderStorage: null,
        memberStorage: {},
      };
      this.save(s);
      this.store.set(key.code(code), s.id);
      return s;
    });
    this.notify(session.id);
    return this.snapshot(session);
  }

  async joinByCode(code: string): Promise<SessionSnapshot> {
    await this.delay();
    const normalized = code.trim().toUpperCase();
    const session = await this.store.withLock(() => {
      const id = this.store.get(key.code(normalized));
      const s = id ? this.load(id) : null;
      if (!s || this.activeMembers(s).length === 0) throw new BackendError('invalid-code', 'No room has that code.');
      const existing = s.members.find((m) => m.userId === this.userId && m.status === 'JOINED');
      if (existing) return s;
      if (this.activeMembers(s).length >= MAX_PLAYERS) throw new BackendError('room-full', 'That room is full.');
      s.members = s.members.filter((m) => m.userId !== this.userId);
      s.members.push({ userId: this.userId, status: 'JOINED', joinedAt: this.now() });
      this.save(s);
      return s;
    });
    this.notify(session.id);
    return this.snapshot(session);
  }

  async getSession(sessionId: string): Promise<SessionSnapshot> {
    await this.delay();
    const s = this.load(sessionId);
    if (!s) throw new BackendError('not-found', 'Session not found.', 404);
    return this.snapshot(s);
  }

  async leaveSession(sessionId: string): Promise<void> {
    // No artificial delay: this also runs while the page is closing.
    await this.store.withLock(() => {
      const s = this.load(sessionId);
      if (!s) return;
      const member = s.members.find((m) => m.userId === this.userId);
      if (member) member.status = 'LEFT';
      this.save(s);
      if (this.activeMembers(s).length === 0) this.store.remove(key.code(s.code));
    });
    this.notify(sessionId);
  }

  async writeLeaderStorage(sessionId: string, data: LeaderState): Promise<void> {
    await this.delay();
    await this.store.withLock(() => {
      const s = this.requireActive(sessionId);
      if (this.snapshot(s).leaderId !== this.userId) {
        throw new BackendError('forbidden', 'Only the session leader can write leader storage.', 403);
      }
      s.leaderStorage = structuredClone(data);
      this.save(s);
    });
    this.notify(sessionId, { kind: 'leader', userId: this.userId, data: structuredClone(data) });
  }

  async writeMemberStorage(sessionId: string, userId: string, data: MemberState): Promise<void> {
    await this.delay();
    if (userId !== this.userId) {
      throw new BackendError('forbidden', 'A player can only write their own storage.', 403);
    }
    await this.store.withLock(() => {
      const s = this.requireActive(sessionId);
      s.memberStorage[userId] = structuredClone(data);
      this.save(s);
    });
    this.notify(sessionId, { kind: 'member', userId, data: structuredClone(data) });
  }

  async createTicket(): Promise<string> {
    await this.delay();
    const { ticketId, matched } = await this.store.withLock(() => {
      const now = this.now();
      const queue = this.loadQueue().filter((t) => now - t.createdAt < this.ticketExpiryMs && t.userId !== this.userId);
      const ticket: StoredTicket = { id: randomId(), userId: this.userId, createdAt: now, sessionId: null };
      const other = queue.shift();
      if (!other) {
        this.saveTicket(ticket);
        this.store.set(key.queue, JSON.stringify([...queue, ticket]));
        return { ticketId: ticket.id, matched: false };
      }
      // Pair with the oldest waiting player. Like AGS, both players join straight
      // away and the player who queued first leads the session.
      let code = randomCode();
      while (this.store.get(key.code(code))) code = randomCode();
      const session: StoredSession = {
        id: randomId(),
        code,
        createdAt: now,
        members: [
          { userId: other.userId, status: 'JOINED', joinedAt: now },
          { userId: this.userId, status: 'JOINED', joinedAt: now + 1 },
        ],
        leaderStorage: null,
        memberStorage: {},
      };
      this.save(session);
      this.store.set(key.code(code), session.id);
      this.saveTicket({ ...other, sessionId: session.id });
      this.saveTicket({ ...ticket, sessionId: session.id });
      this.store.set(key.queue, JSON.stringify(queue));
      return { ticketId: ticket.id, matched: true };
    });
    if (matched) this.store.broadcast({ type: 'match-found' } satisfies BackendEvent);
    return ticketId;
  }

  async getTicket(ticketId: string): Promise<TicketStatus> {
    await this.delay();
    const raw = this.store.get(key.ticket(ticketId));
    if (!raw) throw new BackendError('not-found', 'Ticket not found.', 404);
    const ticket = JSON.parse(raw) as StoredTicket;
    return { matchFound: ticket.sessionId !== null, sessionId: ticket.sessionId };
  }

  async cancelTicket(ticketId: string): Promise<void> {
    await this.store.withLock(() => {
      this.store.set(key.queue, JSON.stringify(this.loadQueue().filter((t) => t.id !== ticketId)));
      this.store.remove(key.ticket(ticketId));
    });
  }

  subscribe(listener: (event: BackendEvent) => void): () => void {
    return this.events.on(listener);
  }

  dispose(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.stopBroadcast();
    this.events.clear();
  }

  // ---------- internals ----------

  private delay(): Promise<void> {
    return this.latencyMs > 0 ? new Promise((r) => setTimeout(r, this.latencyMs)) : Promise.resolve();
  }

  /** Like AGS, a storage notification carries the written value and who wrote it. */
  private notify(sessionId: string, storage?: StorageChange): void {
    this.store.broadcast({ type: 'session-changed', sessionId, ...(storage && { storage }) } satisfies BackendEvent);
  }

  private load(id: string): StoredSession | null {
    const raw = this.store.get(key.session(id));
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  }

  private save(s: StoredSession): void {
    this.store.set(key.session(s.id), JSON.stringify(s));
  }

  private loadQueue(): StoredTicket[] {
    const raw = this.store.get(key.queue);
    return raw ? (JSON.parse(raw) as StoredTicket[]) : [];
  }

  private saveTicket(t: StoredTicket): void {
    this.store.set(key.ticket(t.id), JSON.stringify(t));
  }

  /** Status of a member as AGS would report it, taking missed heartbeats into account. */
  private statusOf(m: StoredMember): SessionMember['status'] {
    if (m.status === 'LEFT') return 'LEFT';
    const beat = Number(this.store.get(key.heartbeat(m.userId)) ?? 0);
    const silentFor = this.now() - beat;
    if (silentFor > this.dropAfterMs) return 'DROPPED';
    if (silentFor > this.disconnectAfterMs) return 'DISCONNECTED';
    return 'JOINED';
  }

  private activeMembers(s: StoredSession): StoredMember[] {
    return s.members.filter((m) => {
      const status = this.statusOf(m);
      return status === 'JOINED' || status === 'DISCONNECTED';
    });
  }

  private snapshot(s: StoredSession): SessionSnapshot {
    const members = s.members.map((m) => ({ userId: m.userId, status: this.statusOf(m) }));
    const stillIn = s.members
      .filter((m) => this.statusOf(m) === 'JOINED' || this.statusOf(m) === 'DISCONNECTED')
      .sort((a, b) => a.joinedAt - b.joinedAt);
    // The first member to join leads; if they are gone, the next oldest takes over.
    const leaderId = stillIn[0]?.userId ?? s.members[0]?.userId ?? '';
    return {
      id: s.id,
      code: s.code,
      leaderId,
      members,
      leaderStorage: structuredClone(s.leaderStorage),
      memberStorage: structuredClone(s.memberStorage),
    };
  }

  private requireActive(sessionId: string): StoredSession {
    const s = this.load(sessionId);
    if (!s) throw new BackendError('not-found', 'Session not found.', 404);
    const me = s.members.find((m) => m.userId === this.userId);
    if (!me || this.statusOf(me) !== 'JOINED') {
      throw new BackendError('forbidden', 'Only active session members can write storage.', 403);
    }
    return s;
  }
}

function isEvent(message: unknown): message is BackendEvent {
  return typeof message === 'object' && message !== null && 'type' in message;
}
