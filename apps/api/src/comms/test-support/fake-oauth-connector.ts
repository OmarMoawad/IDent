import type {
  ConnectedAccount,
  ExchangedTokens,
  OAuthConnectorClient,
  RefreshedTokens,
} from "../connector-types.js";

/**
 * A connector client with nothing Google about it — Phase 2 session 1
 * (IDent_STATE.md).
 *
 * FakeGoogleOAuthClient proves the Gmail path still works. This proves
 * something different and more important for the refactor: that the
 * lifecycle in connection-service.ts runs for a provider whose account
 * identifier is not an email address, whose authorization URL is not
 * Google's, and whose module does not exist. If a Google assumption were
 * still hiding in the shared flow, this is what would catch it — a Slack
 * or Notion session should not be the thing that discovers it.
 */
export class FakeOAuthConnectorClient implements OAuthConnectorClient {
  getAuthorizationUrlCalls: { state: string; codeChallenge: string }[] = [];
  exchangeCodeForTokensCalls: { code: string; codeVerifier: string }[] = [];
  refreshAccessTokenCalls: string[] = [];
  revokeTokenCalls: string[] = [];

  constructor(private readonly authorizationBase = "https://provider.test/oauth/authorize") {}

  nextExchangeResult: ExchangedTokens | Error = {
    accessToken: "workspace-access-token",
    refreshToken: "workspace-refresh-token",
    expiresAt: new Date(Date.now() + 3600_000),
    scope: "channels:history users:read",
  };

  nextRefreshResult: RefreshedTokens | Error = {
    accessToken: "workspace-refreshed-access-token",
    expiresAt: new Date(Date.now() + 3600_000),
    refreshToken: null,
  };

  /**
   * An opaque id with a separate display label — the case Gmail never
   * exercises, because there the two are the same string.
   */
  nextAccount: ConnectedAccount | Error = { id: "U024BE7LH", email: "Acme workspace" };

  getAuthorizationUrl(state: string, codeChallenge: string): string {
    this.getAuthorizationUrlCalls.push({ state, codeChallenge });
    const params = new URLSearchParams({ state, code_challenge: codeChallenge });
    return `${this.authorizationBase}?${params.toString()}`;
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

  async getAccount(): Promise<ConnectedAccount> {
    if (this.nextAccount instanceof Error) throw this.nextAccount;
    return this.nextAccount;
  }
}
