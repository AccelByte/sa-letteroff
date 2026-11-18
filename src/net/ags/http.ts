import { BackendError } from '../backend';

export type Fetch = typeof fetch;

export interface RequestOptions {
  body?: unknown;
  /** Form-encoded body, for OAuth token calls. */
  form?: Record<string, string>;
  headers?: Record<string, string>;
  keepalive?: boolean;
}

/** Calls an AGS REST endpoint and returns the parsed JSON (or null for empty responses). */
export async function agsRequest(
  fetchImpl: Fetch,
  method: string,
  url: string,
  options: RequestOptions = {},
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  let body: string | undefined;
  if (options.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetchImpl(url, { method, headers, body, keepalive: options.keepalive });
  } catch (error) {
    throw new BackendError('network', `Network error: ${String(error)}`);
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message = errorMessage(data) ?? `${method} ${url} failed with HTTP ${response.status}`;
    const kind = response.status === 404 ? 'not-found' : response.status === 403 ? 'forbidden' : 'other';
    throw new BackendError(kind, message, response.status);
  }
  return data;
}

function errorMessage(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const message = d.errorMessage ?? d.message ?? d.error_description;
  return typeof message === 'string' ? message : null;
}
