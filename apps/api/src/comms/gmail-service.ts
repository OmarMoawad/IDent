import {
  type ActiveAccessToken,
  type ConnectorOverrides,
  MissingRefreshTokenError,
  completeConnection,
  disconnectSource,
  getActiveAccessToken,
  startConnection,
} from "./connection-service.js";
import { GMAIL_CONNECTOR_ID } from "./connector-registry.js";
import { type ConnectedSource } from "./store.js";
import { GoogleOAuthError, type GoogleOAuthClient } from "./google-oauth-client.js";

/**
 * Phase 2 session 1 (IDent_STATE.md): what is left of the Gmail service
 * after the OAuth lifecycle moved to connection-service.ts.
 *
 * Every function here is a one-liner that names the provider and forwards.
 * That is the point: the state/PKCE/refresh/encryption logic these used to
 * own is now written once, and adding Slack (session 2) means writing a
 * client and a registry entry, not a third copy of this file.
 *
 * The exported names, signatures and error types are unchanged so that
 * gmail-routes.ts, gmail-sync-service.ts, calendar-sync-service.ts,
 * calendar-routes.ts and this module's own test suite did not have to be
 * touched — the refactor's success criterion, stated in IDent_STATE.md
 * before it was started.
 */

// Re-exported rather than re-declared: gmail-routes.ts catches these by
// class, so they have to be the same classes the connection service throws.
export {
  ConnectedSourceNotConnectedError,
  ConnectedSourceNotFoundError,
  ConnectedSourceOwnershipError,
  OauthStateInvalidError,
} from "./connection-service.js";

export const PROVIDER = GMAIL_CONNECTOR_ID;

function overridesFor(client?: GoogleOAuthClient): ConnectorOverrides {
  return client ? { client } : {};
}

export async function startGmailConnection(
  identityId: string,
  client?: GoogleOAuthClient,
): Promise<{ authorizationUrl: string }> {
  return startConnection(identityId, GMAIL_CONNECTOR_ID, overridesFor(client));
}

export async function completeGmailConnection(
  code: string,
  state: string,
  client?: GoogleOAuthClient,
): Promise<ConnectedSource> {
  try {
    return await completeConnection(GMAIL_CONNECTOR_ID, code, state, overridesFor(client));
  } catch (error) {
    /**
     * Mapped rather than propagated, so the HTTP behaviour is byte-for-byte
     * what it was: gmail-routes.ts turns a `GoogleOAuthError` into its
     * connection-failed redirect, and this is the one case where the
     * generic service raises a provider-neutral error for a situation
     * Google's flow treats as fatal. A Slack connector will not want this
     * mapping — its bot tokens do not expire — which is exactly why the
     * decision lives in the provider's shim and not in the shared flow.
     */
    if (error instanceof MissingRefreshTokenError) {
      throw new GoogleOAuthError("Google did not return a refresh token for this connection.");
    }
    throw error;
  }
}

export type ActiveGmailAccessToken = ActiveAccessToken;

export async function getActiveGmailAccessToken(
  identityId: string,
  sourceId: string,
  client?: GoogleOAuthClient,
): Promise<ActiveGmailAccessToken> {
  return getActiveAccessToken(identityId, sourceId, overridesFor(client));
}

export async function disconnectGmailSource(
  identityId: string,
  sourceId: string,
  client?: GoogleOAuthClient,
): Promise<void> {
  return disconnectSource(identityId, sourceId, overridesFor(client));
}
