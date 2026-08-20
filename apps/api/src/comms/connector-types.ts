/**
 * Phase 2 session 1 (IDent_STATE.md): the provider-agnostic half of the
 * OAuth connector contract.
 *
 * These types lived in `google-oauth-client.ts` and were Google's by
 * accident of being written first — nothing in them is Google-specific.
 * They are here, in a module that imports nothing, so that the generic
 * connection service can depend on the *contract* without depending on
 * any provider's implementation of it, and so adding Slack or Notion
 * (Phase 2 sessions 2 and 3) does not mean importing Google's module to
 * get a type.
 */

export type ExchangedTokens = {
  accessToken: string;
  /**
   * `null` means the provider issued no refresh token for this
   * authorization. Whether that is fatal is the connection service's call,
   * not the client's — for Google it is, because the authorization URL
   * asks for one explicitly.
   */
  refreshToken: string | null;
  expiresAt: Date;
  scope: string;
};

export type RefreshedTokens = {
  accessToken: string;
  expiresAt: Date;
  /** `null` means "unchanged — keep using the refresh token you have". */
  refreshToken: string | null;
};

/**
 * Who a connection belongs to on the provider's side.
 *
 * Split into an id and an email because they are the same string for
 * Gmail and will not be for anything else: a Slack connection is a
 * workspace user id, a Notion connection is a bot/workspace id, and
 * neither is an address. `connected_sources` has always had two columns
 * for this; only the Gmail-shaped flow collapsed them into one value.
 */
export type ConnectedAccount = {
  /** Stable, provider-side identifier. Uniqueness key for a connection. */
  id: string;
  /** Human-readable label, when the provider offers one. */
  email: string | null;
};

/**
 * The seam every connector is driven through. Deliberately the smallest
 * set of operations the OAuth authorization-code + PKCE lifecycle needs:
 * anything provider-specific (Gmail's profile endpoint, Google's
 * `prompt=consent`) lives behind an implementation, never in the flow.
 */
export interface OAuthConnectorClient {
  getAuthorizationUrl(state: string, codeChallenge: string): string;
  exchangeCodeForTokens(code: string, codeVerifier: string): Promise<ExchangedTokens>;
  refreshAccessToken(refreshToken: string): Promise<RefreshedTokens>;
  revokeToken(token: string): Promise<void>;
  getAccount(accessToken: string): Promise<ConnectedAccount>;
}

/** What a connector contributes to the unified inbox, for display and routing. */
export type ConnectorFeed = "mail" | "calendar" | "messages" | "documents";
