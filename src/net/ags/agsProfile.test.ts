/**
 * Request and response shapes for persistence and rankings, as seen against a
 * live AGS namespace (a real 1 × 60 s match between
 * two guest players, then the boards were read back).
 */
import { describe, expect, it, vi } from 'vitest';
import { emptyProgress } from '../../game/progress';
import { BackendError } from '../backend';
import { AgsProfileRemote } from './agsProfile';
import { AgsAuth } from './auth';
import { agsConfigFromEnv } from './config';

const config = agsConfigFromEnv(
  {
    DEV: false,
    VITE_AGS_BASE_URL: 'https://ns.example.io',
    VITE_AGS_NAMESPACE: 'my-ns',
    VITE_AGS_CLIENT_ID: 'client123',
    VITE_AGS_SESSION_TEMPLATE: 'letteroff-room',
  },
  'http://localhost:5173',
);

type Handler = (body: unknown) => { status?: number; data: unknown };

function setup(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = String(url);
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body: unknown = raw.startsWith('{') || raw.startsWith('[') ? JSON.parse(raw) : init?.body;
    calls.push({ method, url: u, body });
    if (u.endsWith('/iam/v3/oauth/platforms/device/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_in: 3600, user_id: 'u1' }));
    }
    const key = Object.keys(routes).find((k) => `${method} ${u}`.includes(k));
    if (!key) return new Response(JSON.stringify({ errorMessage: 'no route' }), { status: 404 });
    const { status = 200, data } = routes[key]!(body);
    return new Response(data === null ? '' : JSON.stringify(data), { status });
  });
  const f = fetchImpl as unknown as typeof fetch;
  const auth = new AgsAuth(f, config.apiBase, config.clientId, 'dev-1');
  return { remote: new AgsProfileRemote(config, auth, f), calls, auth };
}

const CS = 'https://ns.example.io/cloudsave/v1/namespaces/my-ns';
const STATS = 'https://ns.example.io/social';
const LB = 'https://ns.example.io/leaderboard/v3/public/namespaces/my-ns/leaderboards';

describe('AgsProfileRemote', () => {
  it('reads and writes the private history record', async () => {
    const progress = emptyProgress();
    const { remote, calls, auth } = setup({
      [`GET ${CS}/users/u1/records/letteroff-history`]: () => ({ data: { key: 'letteroff-history', value: progress } }),
      [`PUT ${CS}/users/u1/records/letteroff-history`]: () => ({ data: { key: 'letteroff-history' } }),
    });
    expect(await remote.loadProgress()).toEqual(progress);
    await remote.saveProgress(progress);
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: progress });
    auth.dispose();
  });

  it('treats a missing history record (404, error 18022) as no progress yet', async () => {
    const { remote, auth } = setup({
      [`GET ${CS}/users/u1/records/letteroff-history`]: () => ({
        status: 404,
        data: { errorCode: 18022, errorMessage: 'player record not found' },
      }),
    });
    expect(await remote.loadProgress()).toBeNull();
    auth.dispose();
  });

  it('publishes the display name as a public record', async () => {
    const { remote, calls, auth } = setup({ [`PUT ${CS}/users/u1/records/letteroff-profile`]: () => ({ data: {} }) });
    await remote.setPublicName('Hana');
    expect(calls.at(-1)!.body).toEqual({ name: 'Hana', __META: { is_public: true } });
    auth.dispose();
  });

  it('applies a ranked match: MAX letter bests and +1 win, then OVERRIDE the A-Z sum from AGS values', async () => {
    const updates: unknown[] = [];
    const { remote, auth } = setup({
      [`PUT ${STATS}/v2/public/namespaces/my-ns/users/u1/statitems/value/bulk`]: (body) => {
        updates.push(body);
        return { data: (body as { statCode: string }[]).map((b) => ({ statCode: b.statCode, success: true })) };
      },
      [`GET ${STATS}/v1/public/namespaces/my-ns/users/me/statitems/value/bulk`]: () => ({
        data: [
          { profileId: 'u1', statCode: 'letteroff-best-a', value: 4 },
          { profileId: 'u1', statCode: 'letteroff-best-e', value: 10 },
          { profileId: 'u1', statCode: 'letteroff-best-z', value: 0 },
        ],
      }),
    });
    await remote.applyRanking({ win: true, letterScores: { E: 10 } });
    expect(updates[0]).toEqual([
      { statCode: 'letteroff-best-e', updateStrategy: 'MAX', value: 10 },
      { statCode: 'letteroff-wins', updateStrategy: 'INCREMENT', value: 1 },
    ]);
    // Two reads of 13 codes each (AGS caps bulk reads); the mock answers the same for both.
    expect(updates[1]).toEqual([{ statCode: 'letteroff-az-best', updateStrategy: 'OVERRIDE', value: 14 }]);
    auth.dispose();
  });

  it('fails if AGS rejects a stat update', async () => {
    const { remote, auth } = setup({
      [`PUT ${STATS}/v2/public/namespaces/my-ns/users/u1/statitems/value/bulk`]: () => ({
        data: [{ statCode: 'letteroff-wins', success: false, details: { errorCode: 12222 } }],
      }),
    });
    await expect(remote.applyRanking({ win: true, letterScores: {} })).rejects.toBeInstanceOf(BackendError);
    auth.dispose();
  });

  it('reads a board: ranks from position, names from public records, own rank from the user endpoint', async () => {
    const { remote, auth } = setup({
      [`GET ${LB}/letteroff-az-best/alltime?offset=0&limit=20`]: () => ({
        data: {
          data: [
            { userId: 'g1', point: 10, additionalData: {} },
            { userId: 'u1', point: 5, additionalData: {} },
          ],
          paging: {},
        },
      }),
      [`GET ${LB}/letteroff-az-best/users/u1`]: () => ({
        data: { userId: 'u1', allTime: { rank: 2, point: 5 }, cycles: [] },
      }),
      [`POST ${CS}/users/bulk/records/letteroff-profile/public`]: () => ({
        data: { data: [{ user_id: 'g1', key: 'letteroff-profile', value: { name: 'Gus' } }] },
      }),
    });
    expect(await remote.leaderboard('az', 20)).toEqual({
      entries: [
        { rank: 1, userId: 'g1', name: 'Gus', value: 10 },
        { rank: 2, userId: 'u1', name: 'Player', value: 5 },
      ],
      me: { rank: 2, value: 5 },
      myUserId: 'u1',
    });
    auth.dispose();
  });

  it('shows an empty board when AGS answers 404 for a board with no entries yet', async () => {
    const { remote, auth } = setup({
      [`GET ${LB}/letteroff-total-wins/alltime`]: () => ({
        status: 404,
        data: { errorCode: 71235, errorMessage: 'leaderboard ranking not found' },
      }),
      [`GET ${LB}/letteroff-total-wins/users/u1`]: () => ({
        status: 404,
        data: { errorCode: 71233, errorMessage: 'user ranking data not found' },
      }),
    });
    expect(await remote.leaderboard('wins', 20)).toEqual({ entries: [], me: null, myUserId: 'u1' });
    auth.dispose();
  });
});
