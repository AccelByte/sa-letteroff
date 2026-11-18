/**
 * What an online match needs from a backend. Two implementations:
 *
 * - `ags`: AccelByte Gaming Services (guest login, Session V2, Matchmaking V2, Lobby).
 * - `mock`: runs entirely in the browser, so two tabs or windows of the same
 *   browser can play each other with no network. It copies the AGS rules that
 *   matter (leader-only leader storage, own-only member storage, join codes,
 *   member statuses), so the same game code runs against both.
 *
 * Events are only hints that something changed. The game always re-reads the
 * session, and polls on a timer as well, so a missed or unknown notification
 * can only slow an update down, never lose it.
 */
import type { LeaderState, MemberState, SessionSnapshot } from '../game/online/protocol';

export type BackendMode = 'mock' | 'ags';

export interface Player {
  userId: string;
}

export interface TicketStatus {
  matchFound: boolean;
  sessionId: string | null;
}

export type ConnectionState = 'connecting' | 'connected' | 'offline';

/**
 * A storage write carried by a notification: who wrote it and the whole new
 * value (writes replace the stored object). Lets a player apply the change
 * without reading the session again.
 */
export interface StorageChange {
  kind: 'leader' | 'member';
  /** The player who wrote it; for member storage, whose storage it is. */
  userId: string;
  data: unknown;
}

export type BackendEvent =
  | { type: 'session-changed'; sessionId?: string; storage?: StorageChange }
  | { type: 'match-found' }
  | { type: 'connection'; state: ConnectionState };

export interface OnlineBackend {
  readonly mode: BackendMode;
  login(): Promise<Player>;
  /**
   * The backend's clock, in ms since the epoch. Both players measure their
   * offset from it, so round timestamps written by the host mean the same
   * moment on both machines.
   */
  serverTime(): Promise<number>;
  createRoom(): Promise<SessionSnapshot>;
  joinByCode(code: string): Promise<SessionSnapshot>;
  getSession(sessionId: string): Promise<SessionSnapshot>;
  /** `keepalive` lets the request finish while the page is closing. */
  leaveSession(sessionId: string, options?: { keepalive?: boolean }): Promise<void>;
  writeLeaderStorage(sessionId: string, data: LeaderState): Promise<void>;
  writeMemberStorage(sessionId: string, userId: string, data: MemberState): Promise<void>;
  createTicket(): Promise<string>;
  getTicket(ticketId: string): Promise<TicketStatus>;
  cancelTicket(ticketId: string, options?: { keepalive?: boolean }): Promise<void>;
  subscribe(listener: (event: BackendEvent) => void): () => void;
  dispose(): void;
}

export type BackendErrorKind =
  'invalid-code' | 'room-full' | 'not-found' | 'forbidden' | 'network' | 'config' | 'other';

export class BackendError extends Error {
  readonly kind: BackendErrorKind;
  readonly status?: number;

  constructor(kind: BackendErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'BackendError';
    this.kind = kind;
    this.status = status;
  }
}

/** A message a player can read, for any error thrown by a backend call. */
export function describeError(error: unknown): string {
  if (error instanceof BackendError) {
    switch (error.kind) {
      case 'invalid-code':
        return 'No room has that code. Check it and try again.';
      case 'room-full':
        return 'That room already has two players.';
      case 'network':
        return "Couldn't reach the game server. Check your connection and try again.";
      case 'config':
        return error.message;
      default:
        return error.message || 'Something went wrong.';
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** Small listener set shared by both backends. */
export class Emitter<T> {
  private listeners = new Set<(event: T) => void>();

  on(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  clear(): void {
    this.listeners.clear();
  }
}
