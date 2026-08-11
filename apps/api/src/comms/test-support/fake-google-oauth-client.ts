import type { ExchangedTokens, GoogleOAuthClient, RefreshedTokens } from "../google-oauth-client.js";

/**
 * A programmable stand-in for Google's real OAuth endpoints — same role
 * identity/test-support/software-authenticator.ts plays for WebAuthn: lets
 * comms/gmail-service.ts's tests exercise real connect/refresh/disconnect
 * logic without a real Google account, a real network call, or a real
 * authorization code (which only an actual browser consent flow, driven by
 * a human, can ever produce).
 *
 * Every method also records its calls, so a test can assert not just "did
 * this succeed" but "was refreshAccessToken even called" — the near-expiry
 * decision in gmail-service.ts's refresh logic has no other observable
 * side effect to check against.
 */
export class FakeGoogleOAuthClient implements GoogleOAuthClient {
  exchangeCodeForTokensCalls: string[] = [];
  refreshAccessTokenCalls: string[] = [];
  revokeTokenCalls: string[] = [];

  nextExchangeResult: ExchangedTokens | Error = {
    accessToken: "fake-access-token",
    refreshToken: "fake-refresh-token",
    expiresAt: new Date(Date.now() + 3600_000),
    scope: "https://www.googleapis.com/auth/gmail.readonly",
  };

  nextRefreshResult: RefreshedTokens | Error = {
    accessToken: "fake-refreshed-access-token",
    expiresAt: new Date(Date.now() + 3600_000),
    refreshToken: null,
  };

  getAuthorizationUrl(state: string): string {
    return `https://accounts.google.com/o/oauth2/v2/auth?fake=true&state=${encodeURIComponent(state)}`;
  }

  async exchangeCodeForTokens(code: string): Promise<ExchangedTokens> {
    this.exchangeCodeForTokensCalls.push(code);
    if (this.nextExchangeResult instanceof Error) throw this.nextExchangeResult;
    return this.nextExchangeResult;
  }

  async refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
    this.refreshAccessTokenCalls.push(refreshToken);
    if (this.nextRefreshResult instanceof Error) throw this.nextRefreshResult;
    return this.nextRefreshResult;
  }

  async revokeToken(token: string): Promise<void> {
    this.revokeTokenCalls.push(token);
  }
}
