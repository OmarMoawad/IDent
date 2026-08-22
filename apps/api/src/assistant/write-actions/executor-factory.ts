import {
  ConnectedSourceNotConnectedError,
  ConnectedSourceNotFoundError,
  ConnectedSourceOwnershipError,
  getActiveAccessToken,
} from "../../comms/connection-service.js";
import { hasCalendarWriteScope, hasGmailWriteScope } from "../../comms/comms-config.js";
import { RealGoogleMailWriteClient } from "../../comms/google-mail-write-client.js";
import { RealGoogleCalendarWriteClient } from "../../comms/google-calendar-write-client.js";
import {
  DefaultActionExecutorRegistry,
  type ActionExecutorRegistry,
  type WriteCapability,
  type WriteTokenProvider,
} from "./executors.js";

/**
 * Phase 2 session 5 — the production wiring for the executor.
 *
 * The token provider is where the immediate-before-mutation re-checks live:
 * it obtains a *fresh* access token through the connection service (which
 * re-verifies ownership, a live connection, and refreshes if needed) and
 * then requires that the connection actually granted the write scope the
 * action needs. A source connected before session 5's scope raise reads its
 * old read-only grant and is reported `missing_scope` — the reconnect
 * prompt the UI shows — rather than being allowed to attempt a write. Every
 * failure maps to a safe, non-sensitive ineligibility code; a connection
 * error's details never escape.
 */

/** The token accessor, injectable so the scope gating is unit-testable. */
export type ActiveTokenAccessor = (
  identityId: string,
  sourceId: string,
) => Promise<{ accessToken: string; scope: string }>;

export class ConnectionServiceTokenProvider implements WriteTokenProvider {
  constructor(private readonly accessor: ActiveTokenAccessor = getActiveAccessToken) {}

  async tokenFor(input: {
    identityId: string;
    sourceId: string;
    capability: WriteCapability;
  }): Promise<{ accessToken: string } | { ineligible: string }> {
    let token: { accessToken: string; scope: string };
    try {
      token = await this.accessor(input.identityId, input.sourceId);
    } catch (error) {
      return { ineligible: classifyConnectionError(error) };
    }

    const granted =
      input.capability === "gmail.modify"
        ? hasGmailWriteScope(token.scope)
        : hasCalendarWriteScope(token.scope);
    if (!granted) return { ineligible: "missing_scope" };

    return { accessToken: token.accessToken };
  }
}

function classifyConnectionError(error: unknown): string {
  if (error instanceof ConnectedSourceOwnershipError) return "not_owned";
  if (error instanceof ConnectedSourceNotConnectedError) return "not_connected";
  if (error instanceof ConnectedSourceNotFoundError) return "not_connected";
  return "token_unavailable";
}

/** The executor the routes use in a running deployment. */
export function buildProductionExecutor(): ActionExecutorRegistry {
  return new DefaultActionExecutorRegistry(
    new ConnectionServiceTokenProvider(),
    new RealGoogleMailWriteClient(),
    new RealGoogleCalendarWriteClient(),
  );
}
