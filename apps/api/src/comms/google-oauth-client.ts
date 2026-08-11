import {
  GMAIL_SCOPE,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI,
} from "./comms-config.js";

export type ExchangedTokens = {
  accessToken: string;
  // Google only returns a refresh token on first consent (or a re-consent
  // forced via prompt=consent) — null here would mean "no refresh token
  // issued," which getAuthorizationUrl's prompt=consent is specifically
  // there to avoid on a first-time connection.
  refreshToken: string | null;
  expiresAt: Date;
  scope: string;
};

export type RefreshedTokens = {
  accessToken: string;
  expiresAt: Date;
  // Google occasionally rotates the refresh token on refresh too — null
  // means "unchanged, the caller should keep using the existing one."
  refreshToken: string | null;
};

/**
 * The seam gmail-service.ts calls through instead of talking to Google
 * directly — lets comms/test-support/fake-google-oauth-client.ts stand in
 * during tests (same role identity/test-support/software-authenticator.ts
 * plays for WebAuthn: real business logic, no real third party involved).
 */
export interface GoogleOAuthClient {
  getAuthorizationUrl(state: string): string;
  exchangeCodeForTokens(code: string): Promise<ExchangedTokens>;
  refreshAccessToken(refreshToken: string): Promise<RefreshedTokens>;
  revokeToken(token: string): Promise<void>;
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
  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      response_type: "code",
      scope: GMAIL_SCOPE,
      // offline + consent together are what guarantee a refresh token
      // comes back — offline alone only guarantees one on a first-ever
      // consent, and this flow needs one every time a source is
      // (re)connected, not just the first.
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string): Promise<ExchangedTokens> {
    const body = await postToTokenEndpoint({
      code,
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      grant_type: "authorization_code",
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
}

export const googleOAuthClient: GoogleOAuthClient = new RealGoogleOAuthClient();
