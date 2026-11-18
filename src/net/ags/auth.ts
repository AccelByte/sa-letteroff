/**
 * Guest login with AGS device-ID login and a public IAM client (no secret).
 *
 *   POST /iam/v3/oauth/platforms/device/token
 *   Authorization: Basic base64(<clientId>:)
 *   device_id=<random id>
 *
 * Tokens stay in memory only. The access token is refreshed before it expires;
 * if refreshing fails, the device ID simply logs in again.
 */
import { BackendError } from '../backend';
import { type Fetch, agsRequest } from './http';

export interface TokenInfo {
  accessToken: string;
  refreshToken: string | null;
  userId: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  user_id: string;
}

function isTokenResponse(v: unknown): v is TokenResponse {
  const t = v as TokenResponse;
  return typeof t === 'object' && t !== null && typeof t.access_token === 'string' && typeof t.user_id === 'string';
}

export class AgsAuth {
  private token: TokenInfo | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<TokenInfo> | null = null;
  private readonly basic: string;

  constructor(
    private readonly fetchImpl: Fetch,
    private readonly apiBase: string,
    clientId: string,
    private readonly deviceId: string,
    private readonly now: () => number = Date.now,
    private readonly onToken: (token: TokenInfo) => void = () => undefined,
  ) {
    this.basic = `Basic ${btoa(`${clientId}:`)}`;
  }

  get current(): TokenInfo | null {
    return this.token;
  }

  async login(): Promise<TokenInfo> {
    const data = await agsRequest(this.fetchImpl, 'POST', `${this.apiBase}/iam/v3/oauth/platforms/device/token`, {
      headers: { Authorization: this.basic },
      form: { device_id: this.deviceId, skipSetCookie: 'true' },
    });
    return this.accept(data);
  }

  /** Gets a fresh access token, refreshing with the refresh token or logging in again. */
  refresh(): Promise<TokenInfo> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async accessToken(): Promise<string> {
    if (!this.token) return (await this.login()).accessToken;
    if (this.now() >= this.token.expiresAt - 30_000) return (await this.refresh()).accessToken;
    return this.token.accessToken;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private async doRefresh(): Promise<TokenInfo> {
    const refreshToken = this.token?.refreshToken;
    if (refreshToken) {
      try {
        const data = await agsRequest(this.fetchImpl, 'POST', `${this.apiBase}/iam/v3/oauth/token`, {
          headers: { Authorization: this.basic },
          form: { grant_type: 'refresh_token', refresh_token: refreshToken },
        });
        return this.accept(data);
      } catch {
        // Fall through to a fresh device login.
      }
    }
    return this.login();
  }

  private accept(data: unknown): TokenInfo {
    if (!isTokenResponse(data)) throw new BackendError('other', 'Unexpected login response from AGS.');
    const expiresInMs = Math.max(60, data.expires_in || 3600) * 1000;
    this.token = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      userId: data.user_id,
      expiresAt: this.now() + expiresInMs,
    };
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh().catch(() => undefined), expiresInMs * 0.8);
    this.onToken(this.token);
    return this.token;
  }
}
