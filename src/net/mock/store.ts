/**
 * Storage for the mock backend. In the browser it is localStorage, shared by
 * every tab of the same origin, with BroadcastChannel for change hints and the
 * Web Locks API so two tabs never write over each other. Tests use the
 * in-memory version, shared by several mock backends in one process.
 */
export interface MockStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Runs `fn` while holding the store's write lock. */
  withLock<T>(fn: () => T): Promise<T>;
  broadcast(message: unknown): void;
  onBroadcast(listener: (message: unknown) => void): () => void;
}

export function createMemoryStore(): MockStore {
  const data = new Map<string, string>();
  const listeners = new Set<(message: unknown) => void>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
    withLock: <T>(fn: () => T) => {
      const run = chain.then(fn);
      chain = run.catch(() => undefined);
      return run;
    },
    broadcast: (message) => {
      // Deliver asynchronously, like BroadcastChannel.
      queueMicrotask(() => listeners.forEach((l) => l(message)));
    },
    onBroadcast: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const CHANNEL = 'letteroff-mock';
const LOCK = 'letteroff-mock';

export function createBrowserStore(): MockStore {
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  const listeners = new Set<(message: unknown) => void>();
  channel?.addEventListener('message', (e: MessageEvent) => listeners.forEach((l) => l(e.data)));
  const fallback = createMemoryStore();

  return {
    get: (key) => localStorage.getItem(key),
    set: (key, value) => localStorage.setItem(key, value),
    remove: (key) => localStorage.removeItem(key),
    withLock: <T>(fn: () => T) =>
      typeof navigator !== 'undefined' && navigator.locks
        ? (navigator.locks.request(LOCK, () => fn()) as Promise<T>)
        : fallback.withLock(fn),
    broadcast: (message) => {
      channel?.postMessage(message);
      // BroadcastChannel doesn't echo to the sender; tell this tab's listeners too.
      queueMicrotask(() => listeners.forEach((l) => l(message)));
    },
    onBroadcast: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
