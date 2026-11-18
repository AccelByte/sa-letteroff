/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "mock" (default) or "ags". */
  readonly VITE_BACKEND_MODE?: string;
  readonly VITE_AGS_BASE_URL?: string;
  readonly VITE_AGS_NAMESPACE?: string;
  readonly VITE_AGS_CLIENT_ID?: string;
  readonly VITE_AGS_SESSION_TEMPLATE?: string;
  readonly VITE_AGS_MATCH_POOL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
