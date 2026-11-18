/**
 * AGS Lobby WebSocket. The browser can't set an Authorization header on a
 * WebSocket, so the access token goes in the subprotocol, as the AccelByte Web
 * SDK does. Messages are lines of `key: value`.
 *
 * LetterOff uses Lobby for two things: AGS marks a player DISCONNECTED in their
 * session when the socket drops, and notifications tell the game about session
 * and ticket changes straight away instead of waiting for the next poll.
 */
import type { ConnectionState } from '../backend';

export type WebSocketFactory = (url: string, protocol: string) => WebSocket;

export interface LobbyMessage {
  type: string;
  [key: string]: string;
}

export function parseLobbyMessage(raw: string): LobbyMessage | null {
  const fields: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf(': ');
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 2);
    else if (line.endsWith(':')) fields[line.slice(0, -1)] = '';
  }
  return typeof fields.type === 'string' ? (fields as LobbyMessage) : null;
}

const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000];

export class LobbyConnection {
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly getToken: () => Promise<string>,
    private readonly onMessage: (message: LobbyMessage) => void,
    private readonly onState: (state: ConnectionState) => void,
    private readonly createSocket: WebSocketFactory = (u, p) => new WebSocket(u, p),
    private readonly refreshToken: () => Promise<unknown> = async () => undefined,
  ) {}

  async connect(): Promise<void> {
    this.stopped = false;
    this.onState('connecting');
    let token: string;
    try {
      token = await this.getToken();
    } catch {
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;
    const socket = this.createSocket(this.url, token);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.onState('connected');
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      const message = parseLobbyMessage(event.data);
      if (message) this.onMessage(message);
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      this.onState('offline');
      // 4020 means the token expired: refresh before reconnecting.
      if (event.code === 4020) void this.refreshToken().catch(() => undefined);
      this.scheduleRetry();
    });
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'bye');
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.attempt, RETRY_DELAYS_MS.length - 1)]!;
    this.attempt++;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
}
