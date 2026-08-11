import { createHash, randomBytes } from "node:crypto";
import { ACCESS_TOKEN_REFRESH_BUFFER_MS, OAUTH_STATE_TTL_MS } from "./comms-config.js";
import { GoogleOAuthError, googleOAuthClient, type GoogleOAuthClient } from "./google-oauth-client.js";
import {
  type ConnectedSource,
  clearConnectedSourceTokens,
  consumeOauthStateChallenge,
  findConnectedSourceById,
  findConnectedSourceByProviderAccount,
  findConnectedSourceEncryptedTokenData,
  insertConnectedSource,
  insertOauthStateChallenge,
  setConnectedSourceTokens,
} from "./store.js";
import { decryptTokenPayload, encryptTokenPayload } from "./token-encryption.js";

const PROVIDER = "gmail";

export class OauthStateInvalidError extends Error {
  constructor() {
    super("This connection attempt is invalid or has expired. Start again.");
    this.name = "OauthStateInvalidError";
  }
}

export class ConnectedSourceNotFoundError extends Error {
  constructor() {
    super("Connected source not found.");
    this.name = "ConnectedSourceNotFoundError";
  }
}

export class ConnectedSourceOwnershipError extends Error {
  constructor() {
    super("This connected source does not belong to you.");
    this.name = "ConnectedSourceOwnershipError";
  }
}

export class ConnectedSourceNotConnectedError extends Error {
  constructor() {
    super("This connected source has no active tokens (never connected, or already disconnected).");
    this.name = "ConnectedSourceNotConnectedError";
  }
}

/**
 * The shape encrypted inside connected_sources.encrypted_token_data.
 * Access and refresh tokens are handled/rotated independently in the
 * functions below (per IDent_STATE.md's session-2 checklist) even though
 * they're packed into one encrypted blob for storage — refreshing updates
 * accessToken/expiresAt in place and only touches refreshToken if Google
 * actually rotated it.
 */
type StoredTokenPayload = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
  scope: string;
};

/**
 * PKCE (session 14.5, RFC 7636): a fresh, high-entropy verifier per
 * attempt, and the S256 challenge derived from it — `code_challenge` goes
 * on the authorization URL now, `code_verifier` (the verifier itself)
 * only travels at code-exchange time, alongside the state challenge that
 * already ties this attempt to an identity.
 */
function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Starts a Gmail connection: mints a single-use OAuth state + PKCE
 * challenge tying this specific attempt to `identityId`, and returns the
 * URL the client should redirect the browser to. Nothing is written to
 * connected_sources yet — that only happens once the callback actually
 * completes (completeGmailConnection below), so an abandoned consent flow
 * never leaves a half-connected row behind.
 */
export async function startGmailConnection(
  identityId: string,
  client: GoogleOAuthClient = googleOAuthClient,
): Promise<{ authorizationUrl: string }> {
  const state = randomBytes(32).toString("base64url");
  const { verifier, challenge } = generatePkcePair();
  await insertOauthStateChallenge({
    identityId,
    provider: PROVIDER,
    state,
    pkceVerifier: verifier,
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  });
  return { authorizationUrl: client.getAuthorizationUrl(state, challenge) };
}

/**
 * Completes a Gmail connection from the OAuth callback. The identity this
 * connects to comes entirely from the consumed state challenge — see
 * oauth_state_challenges' comment in schema.ts for why the callback
 * request itself carries no other way to identify who it belongs to (it's
 * an anonymous top-level browser redirect from Google, no bearer token).
 * Fetches the connected mailbox's own address (session 14.5) so
 * reconnecting the same Gmail account updates that existing
 * connected_sources row instead of silently accumulating a duplicate —
 * see connected_sources_identity_provider_account_key in schema.ts.
 */
export async function completeGmailConnection(
  code: string,
  state: string,
  client: GoogleOAuthClient = googleOAuthClient,
): Promise<ConnectedSource> {
  const consumed = await consumeOauthStateChallenge(state);
  if (!consumed || consumed.provider !== PROVIDER) throw new OauthStateInvalidError();

  const tokens = await client.exchangeCodeForTokens(code, consumed.pkceVerifier);
  if (!tokens.refreshToken) {
    // getAuthorizationUrl always requests prompt=consent specifically to
    // guarantee a refresh token comes back — treated as a hard failure
    // rather than silently storing a connection that can't outlive one
    // access-token lifetime (typically an hour).
    throw new GoogleOAuthError("Google did not return a refresh token for this connection.");
  }

  const accountEmail = await client.getAccountEmail(tokens.accessToken);

  const payload: StoredTokenPayload = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt.toISOString(),
    scope: tokens.scope,
  };
  const encrypted = encryptTokenPayload(JSON.stringify(payload));

  const existing = await findConnectedSourceByProviderAccount(consumed.identityId, PROVIDER, accountEmail);
  if (existing) {
    await setConnectedSourceTokens(existing.id, encrypted);
    return { ...existing, status: "connected" };
  }

  const source = await insertConnectedSource({
    identityId: consumed.identityId,
    provider: PROVIDER,
    providerAccountId: accountEmail,
    providerAccountEmail: accountEmail,
  });
  await setConnectedSourceTokens(source.id, encrypted);

  return { ...source, status: "connected" };
}

export type ActiveGmailAccessToken = {
  accessToken: string;
  scope: string;
};

/**
 * Returns a currently-usable access token for a connected source, calling
 * Google to refresh it first if it's at or past ACCESS_TOKEN_REFRESH_BUFFER_MS
 * of its real expiry. Re-encrypts and persists the refreshed payload before
 * returning, so callers never have to think about persistence themselves —
 * this is the only function that ever calls client.refreshAccessToken.
 */
export async function getActiveGmailAccessToken(
  identityId: string,
  sourceId: string,
  client: GoogleOAuthClient = googleOAuthClient,
): Promise<ActiveGmailAccessToken> {
  const source = await findConnectedSourceById(sourceId);
  if (!source) throw new ConnectedSourceNotFoundError();
  if (source.identityId !== identityId) throw new ConnectedSourceOwnershipError();

  const encrypted = await findConnectedSourceEncryptedTokenData(sourceId);
  if (source.status !== "connected" || !encrypted) throw new ConnectedSourceNotConnectedError();

  const payload = JSON.parse(decryptTokenPayload(encrypted)) as StoredTokenPayload;
  const expiresAt = new Date(payload.expiresAt);
  const needsRefresh = expiresAt.getTime() - ACCESS_TOKEN_REFRESH_BUFFER_MS <= Date.now();
  if (!needsRefresh) {
    return { accessToken: payload.accessToken, scope: payload.scope };
  }

  const refreshed = await client.refreshAccessToken(payload.refreshToken);
  const updatedPayload: StoredTokenPayload = {
    accessToken: refreshed.accessToken,
    // Only replaced if Google actually rotated it on this refresh — most
    // refresh responses don't include a new one, and the old one is still
    // valid until Google says otherwise.
    refreshToken: refreshed.refreshToken ?? payload.refreshToken,
    expiresAt: refreshed.expiresAt.toISOString(),
    scope: payload.scope,
  };
  await setConnectedSourceTokens(sourceId, encryptTokenPayload(JSON.stringify(updatedPayload)));

  return { accessToken: updatedPayload.accessToken, scope: updatedPayload.scope };
}

/**
 * Disconnects a Gmail source: revokes the token with Google (best-effort —
 * Google being unreachable, or the token already being dead on its side,
 * shouldn't block clearing our own copy) and then clears the stored
 * tokens outright via clearConnectedSourceTokens, which is what actually
 * guarantees future syncs can't touch this source, not the revoke call.
 */
export async function disconnectGmailSource(
  identityId: string,
  sourceId: string,
  client: GoogleOAuthClient = googleOAuthClient,
): Promise<void> {
  const source = await findConnectedSourceById(sourceId);
  if (!source) throw new ConnectedSourceNotFoundError();
  if (source.identityId !== identityId) throw new ConnectedSourceOwnershipError();

  const encrypted = await findConnectedSourceEncryptedTokenData(sourceId);
  if (encrypted) {
    const payload = JSON.parse(decryptTokenPayload(encrypted)) as StoredTokenPayload;
    // Revoking either token revokes both, per Google's OAuth semantics —
    // prefer the refresh token (kills the longer-lived credential).
    await client.revokeToken(payload.refreshToken || payload.accessToken).catch(() => undefined);
  }

  await clearConnectedSourceTokens(sourceId);
}
