import {
  GMAIL_SCOPE,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI,
} from "./comms-config.js";
import type {
  ConnectedAccount,
  ExchangedTokens,
  OAuthConnectorClient,
  RefreshedTokens,
} from "./connector-types.js";

/**
 * Phase 2 session 1: `ExchangedTokens` and `RefreshedTokens` moved to
 * connector-types.ts, because nothing in either of them was ever
 * Google-specific — they described the OAuth authorization-code grant and
 * happened to be written in Google's file first. Re-exported here so the
 * existing imports across this module keep working; new code should take
 * them from connector-types.js.
 */
export type { ExchangedTokens, RefreshedTokens } from "./connector-types.js";

/**
 * The seam gmail-service.ts calls through instead of talking to Google
 * directly — lets comms/test-support/fake-google-oauth-client.ts stand in
 * during tests (same role identity/test-support/software-authenticator.ts
 * plays for WebAuthn: real business logic, no real third party involved).
 *
 * Session 1 of Phase 2 narrows this to "Google's implementation of
 * `OAuthConnectorClient`, plus the one Google-shaped extra it also
 * offers". `getAccountEmail` stays because Google's profile endpoint
 * genuinely returns an address and this client's own test exercises it
 * directly; the generic connection service does not know it exists and
 * calls `getAccount` instead.
 */
export interface GoogleOAuthClient extends OAuthConnectorClient {
  /**
   * The provider's stable identifier for the account that was just
   * connected — for Gmail, the mailbox's own email address (session
   * 14.5). Without this, connected_sources can't tell three separate
   * Gmail connections apart from three redundant connections to the same
   * mailbox — see that table's comment in schema.ts.
   */
  getAccountEmail(accessToken: string): Promise<string>;
}

export class GoogleOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
// Gmail API's own profile endpoint, not the generic OAuth userinfo one —
// returns the connected mailbox's address without needing to request any
// scope beyond gmail.readonly (an /oauth2/userinfo call would need its
// own "email" scope grant on top of what this connector already asks for).
const GMAIL_PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

type TokenEndpointBody = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error_description?: string;
};

async function postToTokenEndpoint(params: Record<string, string>): Promise<TokenEndpointBody> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await response.json().catch(() => null)) as TokenEndpointBody | null;
  if (!response.ok || !body?.access_token) {
    throw new GoogleOAuthError(body?.error_description ?? "Google's token endpoint returned an unexpected response.");
  }
  return body;
}

export class RealGoogleOAuthClient implements GoogleOAuthClient {
  getAuthorizationUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      response_type: "code",
      scope: GOOGLE_OAUTH_SCOPES,
      // offline + consent together are what guarantee a refresh token
      // comes back — offline alone only guarantees one on a first-ever
      // consent, and this flow needs one every time a source is
      // (re)connected, not just the first.
      access_type: "offline",
      prompt: "consent",
      state,
      // PKCE (session 14.5) — this client is confidential (holds a client
      // secret), so PKCE isn't covering for a missing secret the way it
      // does for a public/mobile client; it's defense-in-depth against an
      // authorization code being intercepted or logged somewhere between
      // Google's redirect and this server's callback handler.
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<ExchangedTokens> {
    const body = await postToTokenEndpoint({
      code,
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    });
    return {
      accessToken: body.access_token!,
      refreshToken: body.refresh_token ?? null,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
      scope: body.scope ?? GMAIL_SCOPE,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
    const body = await postToTokenEndpoint({
      refresh_token: refreshToken,
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      grant_type: "refresh_token",
    });
    return {
      accessToken: body.access_token!,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
      refreshToken: body.refresh_token ?? null,
    };
  }

  async revokeToken(token: string): Promise<void> {
    const response = await fetch(`${REVOKE_ENDPOINT}?${new URLSearchParams({ token })}`, { method: "POST" });
    // Google returns 200 for an already-invalid/expired token too (revoking
    // something that's already dead isn't an error) — only a genuine
    // non-2xx (bad request shape, network-level rejection) is worth
    // surfacing as a failure to the caller.
    if (!response.ok) {
      throw new GoogleOAuthError("Could not revoke token with Google.");
    }
  }

  async getAccountEmail(accessToken: string): Promise<string> {
    const response = await fetch(GMAIL_PROFILE_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json().catch(() => null)) as { emailAddress?: string } | null;
    if (!response.ok || !body?.emailAddress) {
      throw new GoogleOAuthError("Could not fetch the connected Gmail account's profile.");
    }
    return body.emailAddress;
  }

  /**
   * The generic form the connection service uses. For Gmail the mailbox
   * address is both the stable id and the human-readable label, so both
   * fields carry it — a coincidence of this provider, not a rule, which is
   * exactly why `ConnectedAccount` keeps them apart.
   */
  async getAccount(accessToken: string): Promise<ConnectedAccount> {
    const emailAddress = await this.getAccountEmail(accessToken);
    return { id: emailAddress, email: emailAddress };
  }
}

export const googleOAuthClient: GoogleOAuthClient = new RealGoogleOAuthClient();
