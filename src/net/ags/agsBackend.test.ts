import { describe, expect, it, vi } from 'vitest';
import { createLeaderState } from '../../game/online/host';
import { PROTOCOL_VERSION, memberState } from '../../game/online/protocol';
import { AgsBackend, storageChangeFrom, toSnapshot } from './agsBackend';
import { agsConfigFromEnv } from './config';
import { parseLobbyMessage } from './lobby';

const config = agsConfigFromEnv(
  {
    DEV: false,
    VITE_AGS_BASE_URL: 'https://ns.example.io/',
    VITE_AGS_NAMESPACE: 'my-ns',
    VITE_AGS_CLIENT_ID: 'client123',
    VITE_AGS_SESSION_TEMPLATE: 'letteroff-room',
    VITE_AGS_MATCH_POOL: 'letteroff-quick',
  },
  'http://localhost:5173',
);

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  keepalive: boolean | undefined;
}

function fakeFetch(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = String(url);
    calls.push({
      method,
      url: u,
      headers: init?.headers as Record<string, string>,
      body: init?.body as string | undefined,
      keepalive: init?.keepalive,
    });
    const key = Object.keys(responses).find((k) => `${method} ${u}`.endsWith(k));
    const data = key ? responses[key] : null;
    return new Response(data === null ? '' : JSON.stringify(data), { status: data === undefined ? 404 : 200 });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

const TOKEN = { access_token: 'tok', refresh_token: 'ref', expires_in: 3600, user_id: 'user-1' };
const SESSION = {
  id: 's1',
  code: 'FXGG98',
  leaderID: 'user-1',
  members: [
    { id: 'user-1', status: 'JOINED', statusV2: 'JOINED' },
    { id: 'user-2', status: 'JOINED', statusV2: 'DISCONNECTED' },
  ],
  storage: { leader: { phase: 'waiting' }, member: { 'user-2': { words: ['ant'] } } },
};

describe('agsConfigFromEnv', () => {
  it('uses the AGS host directly in production builds', () => {
    expect(config.apiBase).toBe('https://ns.example.io');
    expect(config.lobbyUrl).toBe('wss://ns.example.io/lobby');
  });

  it('goes through the dev server proxy in development', () => {
    const dev = agsConfigFromEnv(
      {
        DEV: true,
        VITE_AGS_BASE_URL: 'https://ns.example.io',
        VITE_AGS_NAMESPACE: 'n',
        VITE_AGS_CLIENT_ID: 'c',
        VITE_AGS_SESSION_TEMPLATE: 't',
      },
      'http://localhost:5173',
    );
    expect(dev.apiBase).toBe('');
    expect(dev.lobbyUrl).toBe('ws://localhost:5173/lobby');
    expect(dev.matchPool).toBe('letteroff-quick');
  });

  it('names the missing settings', () => {
    expect(() => agsConfigFromEnv({ VITE_AGS_BASE_URL: 'x' }, '')).toThrow(/VITE_AGS_NAMESPACE/);
  });
});

describe('AgsBackend requests (shapes verified against the live namespace)', () => {
  function backend(responses: Record<string, unknown>) {
    const f = fakeFetch({ 'POST https://ns.example.io/iam/v3/oauth/platforms/device/token': TOKEN, ...responses });
    const b = new AgsBackend({ config, deviceId: 'dev-1', fetchImpl: f.impl, connectLobby: false });
    return { b, calls: f.calls };
  }

  it('logs in as a guest with the device ID and the public client, no secret', async () => {
    const { b, calls } = backend({});
    expect(await b.login()).toEqual({ userId: 'user-1' });
    const [login] = calls;
    expect(login!.url).toBe('https://ns.example.io/iam/v3/oauth/platforms/device/token');
    expect(login!.headers.Authorization).toBe(`Basic ${btoa('client123:')}`);
    expect(login!.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(login!.body).toBe('device_id=dev-1&skipSetCookie=true');
    b.dispose();
  });

  it('creates a room from the session template and joins by code', async () => {
    const { b, calls } = backend({
      'POST https://ns.example.io/session/v1/public/namespaces/my-ns/gamesession': SESSION,
      'POST https://ns.example.io/session/v1/public/namespaces/my-ns/gamesessions/join/code': SESSION,
    });
    await b.login();
    await b.createRoom();
    await b.joinByCode(' fxgg98 ');
    const [, create, join] = calls;
    expect(create!.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(create!.body!)).toEqual({
      configurationName: 'letteroff-room',
      attributes: { game: 'letteroff', protocol: PROTOCOL_VERSION },
    });
    expect(JSON.parse(join!.body!)).toEqual({ code: 'FXGG98' });
    b.dispose();
  });

  it('turns an unknown join code into an invalid-code error', async () => {
    const { b } = backend({
      'POST https://ns.example.io/session/v1/public/namespaces/my-ns/gamesessions/join/code': undefined,
    });
    await b.login();
    await expect(b.joinByCode('NOPE00')).rejects.toMatchObject({ kind: 'invalid-code' });
    b.dispose();
  });

  it('writes leader and member storage with the full object', async () => {
    const { b, calls } = backend({
      'PATCH https://ns.example.io/session/v1/public/namespaces/my-ns/sessions/s1/storage/leader': {},
      'PATCH https://ns.example.io/session/v1/public/namespaces/my-ns/sessions/s1/storage/users/user-1': {},
    });
    await b.login();
    const leader = createLeaderState({ rounds: 3, roundSeconds: 30 });
    const member = memberState('Mira', 0, ['ant'], false);
    await b.writeLeaderStorage('s1', leader);
    await b.writeMemberStorage('s1', 'user-1', member);
    expect(JSON.parse(calls[1]!.body!)).toEqual(leader);
    expect(JSON.parse(calls[2]!.body!)).toEqual(member);
    b.dispose();
  });

  it('leaves with keepalive when the page is closing', async () => {
    const { b, calls } = backend({
      'DELETE https://ns.example.io/session/v1/public/namespaces/my-ns/gamesessions/s1/leave': null,
    });
    await b.login();
    await b.leaveSession('s1', { keepalive: true });
    expect(calls[1]).toMatchObject({ method: 'DELETE', keepalive: true });
    b.dispose();
  });

  it('reads the server clock from AGS Basic (response shape verified live)', async () => {
    const { b, calls } = backend({
      'GET https://ns.example.io/basic/v1/public/misc/time': { currentTime: '2026-11-16T03:05:27.265Z' },
    });
    await b.login();
    expect(await b.serverTime()).toBe(Date.parse('2026-11-16T03:05:27.265Z'));
    expect(calls[1]!.headers.Authorization).toBe('Bearer tok');
    b.dispose();
  });

  it('queues for Quick match with the protocol attribute and reads the ticket', async () => {
    const { b, calls } = backend({
      'POST https://ns.example.io/match2/v1/namespaces/my-ns/match-tickets': { matchTicketID: 't1', queueTime: 0 },
      'GET https://ns.example.io/match2/v1/namespaces/my-ns/match-tickets/t1': {
        sessionID: 's9',
        matchFound: true,
        isActive: false,
      },
    });
    await b.login();
    expect(await b.createTicket()).toBe('t1');
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      matchPool: 'letteroff-quick',
      attributes: { protocol: PROTOCOL_VERSION },
      latencies: {},
    });
    expect(await b.getTicket('t1')).toEqual({ matchFound: true, sessionId: 's9' });
    b.dispose();
  });

  it('refreshes the token once on 401 and retries', async () => {
    let first = true;
    const f = fakeFetch({});
    const impl = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/gamesessions/s1') && first) {
        first = false;
        await f.impl(url, init);
        return new Response('{}', { status: 401 });
      }
      if (String(url).endsWith('/oauth/token') || String(url).endsWith('/device/token')) {
        await f.impl(url, init);
        return new Response(JSON.stringify({ ...TOKEN, access_token: first ? 'tok' : 'tok2' }), { status: 200 });
      }
      await f.impl(url, init);
      return new Response(JSON.stringify(SESSION), { status: 200 });
    }) as typeof fetch;
    const b = new AgsBackend({ config, deviceId: 'dev-1', fetchImpl: impl, connectLobby: false });
    await b.login();
    await b.getSession('s1');
    const refresh = f.calls.find((c) => c.url.endsWith('/iam/v3/oauth/token'))!;
    expect(refresh.body).toBe('grant_type=refresh_token&refresh_token=ref');
    expect(f.calls.at(-1)!.headers.Authorization).toBe('Bearer tok2');
    b.dispose();
  });
});

describe('toSnapshot', () => {
  it('maps an AGS session, preferring statusV2', () => {
    expect(toSnapshot(SESSION)).toEqual({
      id: 's1',
      code: 'FXGG98',
      leaderId: 'user-1',
      members: [
        { userId: 'user-1', status: 'JOINED' },
        { userId: 'user-2', status: 'DISCONNECTED' },
      ],
      leaderStorage: { phase: 'waiting' },
      memberStorage: { 'user-2': { words: ['ant'] } },
    });
  });

  it('handles a session without storage', () => {
    expect(toSnapshot({ id: 'x', members: [] })).toMatchObject({ leaderStorage: null, memberStorage: {}, code: null });
  });
});

describe('parseLobbyMessage', () => {
  it('reads key: value lines', () => {
    expect(parseLobbyMessage('type: messageNotif\nid: 1\ntopic: OnSessionStorageChanged\npayload: e30=')).toEqual({
      type: 'messageNotif',
      id: '1',
      topic: 'OnSessionStorageChanged',
      payload: 'e30=',
    });
    expect(parseLobbyMessage('garbage')).toBeNull();
  });
});

describe('storageChangeFrom', () => {
  const notif = (payload: object) =>
    parseLobbyMessage(
      `type: messageSessionNotif\nid: n1\ntopic: OnSessionStorageChanged\npayload: ${btoa(JSON.stringify(payload))}`,
    )!;

  it('reads leader and member storage changes from the notification payload', () => {
    const leader = { v: 1 };
    expect(
      storageChangeFrom(notif({ SessionID: 's1', ActorUserID: 'host', IsLeader: true, StorageChanges: leader })),
    ).toEqual({ sessionId: 's1', storage: { kind: 'leader', userId: 'host', data: leader } });
    expect(storageChangeFrom(notif({ SessionID: 's1', ActorUserID: 'guest', StorageChanges: { w: 1 } }))).toEqual({
      sessionId: 's1',
      storage: { kind: 'member', userId: 'guest', data: { w: 1 } },
    });
  });

  it('ignores other topics and malformed payloads', () => {
    const raw = (topic: string, payload: string) =>
      parseLobbyMessage(`type: messageSessionNotif\ntopic: ${topic}\npayload: ${payload}`)!;
    expect(storageChangeFrom(raw('OnSessionJoined', 'e30='))).toBeNull();
    expect(storageChangeFrom(raw('OnSessionStorageChanged', '!!'))).toBeNull();
    expect(storageChangeFrom(notif({ SessionID: 's1' }))).toBeNull();
  });
});
