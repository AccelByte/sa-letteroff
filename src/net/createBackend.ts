import { type BackendMode, BackendError, type OnlineBackend } from './backend';
import { AgsBackend } from './ags/agsBackend';
import { AgsAuth } from './ags/auth';
import { AgsProfileRemote } from './ags/agsProfile';
import { type AgsConfig, agsConfigFromEnv } from './ags/config';
import { LocalProfileRemote } from './profile/localRemote';
import { type KeyValueStorage, ProfileStore } from './profile/profileStore';
import { MockBackend } from './mock/mockBackend';
import { createBrowserStore } from './mock/store';

/** VITE_BACKEND_MODE selects the backend: "mock" (default) or "ags". */
export function backendModeFromEnv(): BackendMode {
  const mode = (import.meta.env.VITE_BACKEND_MODE ?? 'mock').toLowerCase();
  if (mode !== 'mock' && mode !== 'ags') {
    throw new BackendError('config', `VITE_BACKEND_MODE must be "mock" or "ags", not "${mode}".`);
  }
  return mode;
}

function storedId(storage: Storage, key: string, prefix: string): string {
  try {
    const existing = storage.getItem(key);
    if (existing) return existing;
    const id = `${prefix}${crypto.randomUUID().replace(/-/g, '')}`;
    storage.setItem(key, id);
    return id;
  } catch {
    return `${prefix}${crypto.randomUUID().replace(/-/g, '')}`;
  }
}

/**
 * Mock mode: each browser tab is its own guest, so two windows of one browser
 * can play each other. The ID survives reloads of that tab (sessionStorage).
 */
export const mockGuestId = () => storedId(sessionStorage, 'letteroff:mock-user', 'guest-');

/**
 * AGS mode: one guest per browser (localStorage), so saved history and
 * rankings stay with the player. To play yourself, use a second browser or a
 * private window.
 */
const agsDeviceId = () => storedId(localStorage, 'letteroff:device-id', 'letteroff-web-');

let agsShared: { config: AgsConfig; auth: AgsAuth } | null = null;

/** One AGS login for the whole page, shared by online play and the profile (history, leaderboards). */
function agsSession() {
  if (!agsShared) {
    const config = agsConfigFromEnv(import.meta.env, window.location.origin);
    agsShared = {
      config,
      auth: new AgsAuth((...args) => fetch(...args), config.apiBase, config.clientId, agsDeviceId()),
    };
  }
  return agsShared;
}

function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Where finished matches and rankings are saved: AGS Cloud Save/Statistics/Leaderboard, or localStorage in mock mode. */
export function createProfileStore(mode: BackendMode = backendModeFromEnv()): ProfileStore {
  const storage = browserStorage();
  if (mode === 'ags') {
    const { config, auth } = agsSession();
    return new ProfileStore(new AgsProfileRemote(config, auth, undefined, storage), storage);
  }
  const memory = new Map<string, string>();
  const fallback: KeyValueStorage = {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
    removeItem: (k) => void memory.delete(k),
  };
  return new ProfileStore(
    new LocalProfileRemote(storage ?? fallback, mockGuestId),
    storage,
    `letteroff:outbox:local:${mockGuestId()}`,
  );
}

export function createBackend(mode: BackendMode = backendModeFromEnv()): OnlineBackend {
  if (mode === 'ags') {
    const { config, auth } = agsSession();
    return new AgsBackend({ config, deviceId: agsDeviceId(), auth });
  }
  return new MockBackend({ store: createBrowserStore(), userId: mockGuestId(), latencyMs: 80 });
}
