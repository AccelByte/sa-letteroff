import { BackendError } from '../backend';

export interface AgsConfig {
  /** Where REST calls go. Empty string means "this page's origin" (the Vite dev proxy). */
  apiBase: string;
  /** WebSocket URL of the Lobby service. */
  lobbyUrl: string;
  namespace: string;
  clientId: string;
  sessionTemplate: string;
  matchPool: string;
}

interface EnvLike {
  DEV?: boolean;
  VITE_AGS_BASE_URL?: string;
  VITE_AGS_NAMESPACE?: string;
  VITE_AGS_CLIENT_ID?: string;
  VITE_AGS_SESSION_TEMPLATE?: string;
  VITE_AGS_MATCH_POOL?: string;
}

/**
 * Reads AGS settings from Vite env variables. In development the browser talks
 * to the Vite dev server, which proxies AGS paths (see vite.config.ts), because
 * AGS Public Cloud doesn't accept browser requests from arbitrary origins.
 */
export function agsConfigFromEnv(env: EnvLike, origin: string): AgsConfig {
  const missing = (
    ['VITE_AGS_BASE_URL', 'VITE_AGS_NAMESPACE', 'VITE_AGS_CLIENT_ID', 'VITE_AGS_SESSION_TEMPLATE'] as const
  ).filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new BackendError(
      'config',
      `Online play needs ${missing.join(', ')}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  const baseUrl = env.VITE_AGS_BASE_URL!.replace(/\/+$/, '');
  const httpBase = env.DEV ? origin : baseUrl;
  return {
    apiBase: env.DEV ? '' : baseUrl,
    lobbyUrl: `${httpBase.replace(/^http/, 'ws')}/lobby`,
    namespace: env.VITE_AGS_NAMESPACE!,
    clientId: env.VITE_AGS_CLIENT_ID!,
    sessionTemplate: env.VITE_AGS_SESSION_TEMPLATE!,
    matchPool: env.VITE_AGS_MATCH_POOL || 'letteroff-quick',
  };
}
