import { createHash, randomBytes } from "node:crypto";
import { ACCESS_TOKEN_REFRESH_BUFFER_MS, OAUTH_STATE_TTL_MS } from "./comms-config.js";
import {
  type Connector,
  type ConnectorRegistry,
  connectorRegistry,
  requireConnector,
} from "./connector-registry.js";
import {
  type ConnectedSource,
  clearConnectedSourceTokens,
  consumeOauthStateChallenge,
  findConnectedSourceById,
  findConnectedSourceEncryptedTokenData,
  insertOauthStateChallenge,
  setConnectedSourceTokens,
  upsertConnectedSourceConnection,
} from "./store.js";
import { decryptTokenPayload, encryptTokenPayload } from "./token-encryption.js";

/**
 * Phase 2 session 1 (IDent_STATE.md): the OAuth connection lifecycle, once,
 * for every provider.
 *
 * This is gmail-service.ts's logic with the word "Gmail" taken out of it.
 * Nothing here knows a Google endpoint, a Google scope, or that an account
 * identifier might look like an email address — all of that is behind
 * `Connector.client`. gmail-service.ts is now a four-function shim over
 * this, kept so its routes, its sync service and its existing test suite
 * carry on unchanged.
 *
 * No new user-facing behaviour: same URLs, same responses, same errors.
 * The test that this refactor is correct is that the Gmail suite passes
 * without being edited, and connection-service.test.ts drives the same
 * lifecycle through a connector that has nothing to do with Google.
 */

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
 * Thrown when a provider completes an authorization without issuing a
 * refresh token. Provider-neutral on purpose: gmail-service.ts maps it to
 * the `GoogleOAuthError` its routes already handle, so the HTTP behaviour
 * is unchanged, while a future Slack connector is free to treat it
 * differently — Slack's bot tokens do not expire, so for that connector
 * this is not an error at all.
 */
export class MissingRefreshTokenError extends Error {
  constructor(readonly providerId: string) {
    super(`${providerId} did not return a refresh token for this connection.`);
    this.name = "MissingRefreshTokenError";
  }
}

/**
 * The shape encrypted inside connected_sources.encrypted_token_data.
 * Access and refresh tokens are handled/rotated independently in the
 * functions below (per IDent_STATE.md's session-2 checklist) even though
 * they're packed into one encrypted blob for storage — refreshing updates
 * accessToken/expiresAt in place and only touches refreshToken if the
 * provider actually rotated it.
 */
type StoredTokenPayload =
  | { strategy: "static"; accessToken: string; scope: string }
  | {
      strategy: "refresh-required";
      accessToken: string;
      refreshToken: string;
      expiresAt: string;
      scope: string;
    };

export class ConnectorOutputInvalidError extends Error {
  constructor(providerId: string, detail: string) {
    super(`Invalid connector output from ${providerId}: ${detail}.`);
    this.name = "ConnectorOutputInvalidError";
  }
}

function requiredText(value: string, providerId: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ConnectorOutputInvalidError(providerId, `${field} must be 1-${maxLength} characters`);
  }
  return normalized;
}

function accountLabel(value: string | null, providerId: string): string | null {
  if (value === null) return null;
  return requiredText(value, providerId, "account label", 512);
}

function parseStoredTokenPayload(serialized: string): StoredTokenPayload {
  return JSON.parse(serialized) as StoredTokenPayload;
}

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
 * Lets a caller override just the client (which is what every existing
 * Gmail call site does, passing a fake) without having to construct a
 * whole registry entry. The registry stays the source of truth for
 * everything else about the provider.
 */
export type ConnectorOverrides = {
  registry?: ConnectorRegistry;
  client?: Connector["client"];
};

function resolve(providerId: string, overrides: ConnectorOverrides = {}): Connector {
  const connector = requireConnector(overrides.registry ?? connectorRegistry, providerId);
  return overrides.client ? { ...connector, client: overrides.client } : connector;
}

/**
 * Starts a connection: mints a single-use OAuth state + PKCE challenge
 * tying this specific attempt to `identityId`, and returns the URL the
 * client should redirect the browser to. Nothing is written to
 * connected_sources yet — that only happens once the callback actually
 * completes (completeConnection below), so an abandoned consent flow
 * never leaves a half-connected row behind.
 */
export async function startConnection(
  identityId: string,
  providerId: string,
  overrides: ConnectorOverrides = {},
): Promise<{ authorizationUrl: string }> {
  const connector = resolve(providerId, overrides);
  const state = randomBytes(32).toString("base64url");
  const { verifier, challenge } = generatePkcePair();
  await insertOauthStateChallenge({
    identityId,
    provider: connector.id,
    state,
    pkceVerifier: verifier,
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  });
  return { authorizationUrl: connector.client.getAuthorizationUrl(state, challenge) };
}

/**
 * Completes a connection from the OAuth callback. The identity this
 * connects to comes entirely from the consumed state challenge — see
 * oauth_state_challenges' comment in schema.ts for why the callback
 * request itself carries no other way to identify who it belongs to (it's
 * an anonymous top-level browser redirect from the provider, no bearer
 * token). The stored challenge's own `provider` is checked against the
 * connector being completed, so a state minted for one provider can never
 * be redeemed at another's callback.
 */
export async function completeConnection(
  providerId: string,
  code: string,
  state: string,
  overrides: ConnectorOverrides = {},
): Promise<ConnectedSource> {
  const connector = resolve(providerId, overrides);

  const consumed = await consumeOauthStateChallenge(state);
  if (!consumed || consumed.provider !== connector.id) throw new OauthStateInvalidError();

  const tokens = await connector.client.exchangeCodeForTokens(code, consumed.pkceVerifier);
  const accessToken = requiredText(tokens.accessToken, connector.id, "access token", 16_384);
  const scope = requiredText(tokens.scope || connector.fallbackScope, connector.id, "scope", 4_096);
  if (connector.tokenStrategy === "refresh-required" && !tokens.refreshToken?.trim()) {
    // Google's getAuthorizationUrl always requests prompt=consent
    // specifically to guarantee a refresh token comes back — treated as a
    // hard failure rather than silently storing a connection that can't
    // outlive one access-token lifetime (typically an hour).
    throw new MissingRefreshTokenError(connector.id);
  }

  if (
    connector.tokenStrategy === "refresh-required" &&
    (!(tokens.expiresAt instanceof Date) ||
      !Number.isFinite(tokens.expiresAt.getTime()) ||
      tokens.expiresAt.getTime() <= Date.now())
  ) {
    throw new ConnectorOutputInvalidError(connector.id, "expiry must be a valid future date");
  }

  const account = await connector.client.getAccount(accessToken);
  const accountId = requiredText(account.id, connector.id, "account id", 512);
  const email = accountLabel(account.email, connector.id);

  const payload: StoredTokenPayload = connector.tokenStrategy === "static"
    ? { strategy: "static", accessToken, scope }
    : {
        strategy: "refresh-required",
        accessToken,
        refreshToken: tokens.refreshToken!.trim(),
        expiresAt: tokens.expiresAt!.toISOString(),
        scope,
      };
  const encrypted = encryptTokenPayload(JSON.stringify(payload));

  return upsertConnectedSourceConnection({
    identityId: consumed.identityId,
    provider: connector.id,
    providerAccountId: accountId,
    providerAccountEmail: email,
    encryptedTokenData: encrypted,
  });
}

export type ActiveAccessToken = {
  accessToken: string;
  scope: string;
};

/**
 * Returns a currently-usable access token for a connected source, calling
 * the provider to refresh it first if it's at or past
 * ACCESS_TOKEN_REFRESH_BUFFER_MS of its real expiry. Re-encrypts and
 * persists the refreshed payload before returning, so callers never have
 * to think about persistence themselves — this is the only function that
 * ever calls client.refreshAccessToken.
 *
 * The connector is taken from the source's own `provider` column rather
 * than from an argument: the caller has a source id, and which provider it
 * belongs to is a fact about the row, not something a call site should be
 * able to get wrong.
 */
export async function getActiveAccessToken(
  identityId: string,
  sourceId: string,
  overrides: ConnectorOverrides = {},
): Promise<ActiveAccessToken> {
  const source = await findConnectedSourceById(sourceId);
  if (!source) throw new ConnectedSourceNotFoundError();
  if (source.identityId !== identityId) throw new ConnectedSourceOwnershipError();

  const connector = resolve(source.provider, overrides);

  const encrypted = await findConnectedSourceEncryptedTokenData(sourceId);
  if (source.status !== "connected" || !encrypted) throw new ConnectedSourceNotConnectedError();

  const payload = parseStoredTokenPayload(decryptTokenPayload(encrypted));
  if (payload.strategy === "static") {
    return { accessToken: payload.accessToken, scope: payload.scope };
  }
  const expiresAt = new Date(payload.expiresAt);
  const needsRefresh = expiresAt.getTime() - ACCESS_TOKEN_REFRESH_BUFFER_MS <= Date.now();
  if (!needsRefresh) {
    return { accessToken: payload.accessToken, scope: payload.scope };
  }

  const refreshed = await connector.client.refreshAccessToken(payload.refreshToken);
  const refreshedAccessToken = requiredText(
    refreshed.accessToken,
    connector.id,
    "refreshed access token",
    16_384,
  );
  if (
    !(refreshed.expiresAt instanceof Date) ||
    !Number.isFinite(refreshed.expiresAt.getTime()) ||
    refreshed.expiresAt.getTime() <= Date.now()
  ) {
    throw new ConnectorOutputInvalidError(connector.id, "refreshed expiry must be a valid future date");
  }
  const rotatedRefreshToken = refreshed.refreshToken === null
    ? payload.refreshToken
    : requiredText(refreshed.refreshToken, connector.id, "refreshed refresh token", 16_384);
  const updatedPayload: StoredTokenPayload = {
    strategy: "refresh-required",
    accessToken: refreshedAccessToken,
    // Only replaced if the provider actually rotated it on this refresh —
    // most refresh responses don't include a new one, and the old one is
    // still valid until the provider says otherwise.
    refreshToken: rotatedRefreshToken,
    expiresAt: refreshed.expiresAt.toISOString(),
    scope: payload.scope,
  };
  await setConnectedSourceTokens(sourceId, encryptTokenPayload(JSON.stringify(updatedPayload)));

  return { accessToken: updatedPayload.accessToken, scope: updatedPayload.scope };
}

/**
 * Disconnects a source: revokes the token with the provider (best-effort —
 * the provider being unreachable, or the token already being dead on its
 * side, shouldn't block clearing our own copy) and then clears the stored
 * tokens outright via clearConnectedSourceTokens, which is what actually
 * guarantees future syncs can't touch this source, not the revoke call.
 */
export async function disconnectSource(
  identityId: string,
  sourceId: string,
  overrides: ConnectorOverrides = {},
): Promise<void> {
  const source = await findConnectedSourceById(sourceId);
  if (!source) throw new ConnectedSourceNotFoundError();
  if (source.identityId !== identityId) throw new ConnectedSourceOwnershipError();

  const connector = resolve(source.provider, overrides);

  const encrypted = await findConnectedSourceEncryptedTokenData(sourceId);
  if (encrypted) {
    const payload = parseStoredTokenPayload(decryptTokenPayload(encrypted));
    const revokeToken = payload.strategy === "static" ? payload.accessToken : payload.refreshToken;
    await connector.client.revokeToken(revokeToken).catch(() => undefined);
  }

  await clearConnectedSourceTokens(sourceId);
}
