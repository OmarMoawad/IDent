import type { ConnectedAccount } from "../connector-types.js";
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
 * side effect to check against. exchangeCodeForTokensCalls and
 * getAuthorizationUrl's recorded codeChallenge/codeVerifier let a test
 * prove the *same* PKCE verifier that built the authorization URL is the
 * one that reaches token exchange, without this fake re-deriving or
 * checking the SHA-256 relationship itself (that's Google's job, not this
 * double's — see google-oauth-client.test.ts for the real client's own
 * unit test of that math).
 */
export class FakeGoogleOAuthClient implements GoogleOAuthClient {
  getAuthorizationUrlCalls: { state: string; codeChallenge: string }[] = [];
  exchangeCodeForTokensCalls: { code: string; codeVerifier: string }[] = [];
  refreshAccessTokenCalls: string[] = [];
  revokeTokenCalls: string[] = [];
  getAccountEmailCalls: string[] = [];

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

  nextAccountEmail: string | Error = "fake.connected.account@gmail.com";

  getAuthorizationUrl(state: string, codeChallenge: string): string {
    this.getAuthorizationUrlCalls.push({ state, codeChallenge });
    const params = new URLSearchParams({ fake: "true", state, code_challenge: codeChallenge });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<ExchangedTokens> {
    this.exchangeCodeForTokensCalls.push({ code, codeVerifier });
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

  async getAccountEmail(accessToken: string): Promise<string> {
    this.getAccountEmailCalls.push(accessToken);
    if (this.nextAccountEmail instanceof Error) throw this.nextAccountEmail;
    return this.nextAccountEmail;
  }

  /**
   * Phase 2 session 1: the generic form the connection service calls.
   * Added alongside `getAccountEmail` rather than replacing it, so every
   * existing test that programs `nextAccountEmail` keeps working — the
   * refactor was required to leave the Gmail suite untouched, and quietly
   * renaming what its double exposes would have broken that promise on a
   * technicality.
   */
  async getAccount(accessToken: string): Promise<ConnectedAccount> {
    const emailAddress = await this.getAccountEmail(accessToken);
    return { id: emailAddress, email: emailAddress };
  }
}
