import { GMAIL_SCOPE, GOOGLE_CALENDAR_SCOPE } from "./comms-config.js";
import type { ConnectorFeed, OAuthConnectorClient } from "./connector-types.js";
import { googleOAuthClient } from "./google-oauth-client.js";

/**
 * Phase 2 session 1 (IDent_STATE.md): the provider registry.
 *
 * Before this, "which provider" was not a value anywhere — it was the
 * literal `"gmail"` in gmail-service.ts and the hardcoded Google endpoints
 * in google-oauth-client.ts. `connected_sources.provider` was already a
 * plain string column, so the *table* was generic while the only code path
 * that could write to it was not.
 *
 * Doing this before Slack and Notion rather than after is the whole point:
 * the state/PKCE/token-refresh/encryption dance is subtle, it is written
 * once here, and a bug in it gets fixed once instead of three times.
 */

export type Connector = {
  /** Written verbatim into `connected_sources.provider`. */
  readonly id: string;
  readonly displayName: string;
  /** What this connector contributes to the unified inbox. */
  readonly feeds: readonly ConnectorFeed[];
  /**
   * The scope string recorded against a connection when the provider's
   * token response doesn't echo one back. Not used to *request* scope —
   * that belongs to the client's authorization URL, where the provider's
   * own parameter names apply.
   */
  readonly fallbackScope: string;
  readonly client: OAuthConnectorClient;
};

export type ConnectorRegistry = ReadonlyMap<string, Connector>;

export class UnknownConnectorError extends Error {
  constructor(providerId: string) {
    super(`No connector is registered for provider "${providerId}".`);
    this.name = "UnknownConnectorError";
  }
}

export function buildConnectorRegistry(connectors: readonly Connector[]): ConnectorRegistry {
  const registry = new Map<string, Connector>();
  for (const connector of connectors) {
    if (registry.has(connector.id)) {
      // A duplicate id would silently shadow a connector and route real
      // users' tokens through the wrong client, so it fails at startup
      // rather than at connect time.
      throw new Error(`Duplicate connector id "${connector.id}".`);
    }
    registry.set(connector.id, connector);
  }
  return registry;
}

export function requireConnector(registry: ConnectorRegistry, providerId: string): Connector {
  const connector = registry.get(providerId);
  if (!connector) throw new UnknownConnectorError(providerId);
  return connector;
}

export const GMAIL_CONNECTOR_ID = "gmail";

/**
 * Gmail is one entry in a list rather than the shape of the module. It
 * declares `calendar` alongside `mail` because `GOOGLE_OAUTH_SCOPES`
 * already requests both scopes in the same consent — the connection has
 * always carried calendar access; nothing said so anywhere.
 */
export const gmailConnector: Connector = {
  id: GMAIL_CONNECTOR_ID,
  displayName: "Gmail",
  feeds: ["mail", "calendar"],
  fallbackScope: `${GMAIL_SCOPE} ${GOOGLE_CALENDAR_SCOPE}`,
  client: googleOAuthClient,
};

/** The registry the running application uses. Tests build their own. */
export const connectorRegistry: ConnectorRegistry = buildConnectorRegistry([gmailConnector]);
